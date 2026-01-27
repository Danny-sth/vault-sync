import { App, TFile, Notice } from "obsidian";
import { VaultSyncSettings } from "./settings";

// Message types
export interface SyncMessage {
  type: "file_change" | "file_delete" | "file_move" | "request_full_sync" | "request_file" | "ping";
  deviceId: string;
  timestamp: number;
  vectorClock: Record<string, number>;
  payload: FileChangePayload | FileDeletePayload | FileMovePayload | RequestFilePayload | null;
}

export interface RequestFilePayload {
  path: string;
}

export interface FileChangePayload {
  path: string;
  content: string; // Base64 encoded
  mtime: number;
  hash: string;
  previousHash?: string;
}

export interface FileDeletePayload {
  path: string;
}

export interface FileMovePayload {
  oldPath: string;
  newPath: string;
  content: string; // Base64 encoded
  mtime: number;
  hash: string;
}

export interface ServerMessage {
  type: "file_changed" | "file_deleted" | "file_moved" | "full_sync" | "conflict" | "pong";
  originDevice: string;
  payload: unknown;
}

export interface FileInfo {
  path: string;
  hash: string;
  size: number;
  mtime: number;
}

export interface FullSyncPayload {
  files: FileInfo[];
  tombstones: Tombstone[];
  vectorClock: Record<string, number>;
}

export interface Tombstone {
  path: string;
  deletedAt: number;
  deletedBy: string;
  vectorClock: Record<string, number>;
  ttl: number;
}

export interface ConflictPayload {
  path: string;
  serverVersion: FileChangePayload;
  clientVersion: FileChangePayload;
  resolution: string;
}

export class SyncManager {
  private app: App;
  private settings: VaultSyncSettings;
  private ws: WebSocket | null = null;
  private pendingChanges: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private localHashes: Map<string, string> = new Map();
  private vectorClock: Map<string, number> = new Map();
  private isProcessingRemote = false;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  onConnectionChange: ((connected: boolean) => void) | null = null;

  constructor(app: App, settings: VaultSyncSettings) {
    this.app = app;
    this.settings = settings;
    // Initialize vector clock with own device
    this.vectorClock.set(settings.deviceId, 0);
  }

  // Vector clock operations
  private incrementVectorClock(): void {
    const current = this.vectorClock.get(this.settings.deviceId) || 0;
    this.vectorClock.set(this.settings.deviceId, current + 1);
  }

  private mergeVectorClock(remoteClock: Record<string, number>): void {
    for (const [device, clock] of Object.entries(remoteClock)) {
      const local = this.vectorClock.get(device) || 0;
      this.vectorClock.set(device, Math.max(local, clock));
    }
  }

  private getVectorClockObject(): Record<string, number> {
    const result: Record<string, number> = {};
    this.vectorClock.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  updateSettings(settings: VaultSyncSettings) {
    this.settings = settings;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.ws) {
      this.ws.close();
    }

    if (!this.settings.serverUrl || !this.settings.token) {
      new Notice("Vault sync: server URL and token are required");
      return;
    }

    const url = new URL(this.settings.serverUrl);
    url.searchParams.set("token", this.settings.token);
    url.searchParams.set("device_id", this.settings.deviceId);

    try {
      this.ws = new WebSocket(url.toString());
    } catch (e) {
      new Notice(`Vault sync: failed to create WebSocket: ${e}`);
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      new Notice("Vault sync: connected");
      this.onConnectionChange?.(true);

      if (this.settings.syncOnStart) {
        this.requestFullSync();
      }
    };

    this.ws.onclose = (event) => {
      this.onConnectionChange?.(false);

      if (!event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;
        new Notice(`Vault sync: reconnecting in ${delay / 1000}s...`);
        this.reconnectTimeout = setTimeout(() => this.connect(), delay);
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        new Notice("Vault sync: max reconnect attempts reached");
      }
    };

    this.ws.onerror = (error) => {
      console.error("Vault Sync WebSocket error:", error);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        void this.handleServerMessage(msg);
      } catch (e) {
        console.error("Vault sync: Failed to parse message:", e);
      }
    };
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnect

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    new Notice("Vault sync: disconnected");
    this.onConnectionChange?.(false);
  }

  requestFullSync(): void {
    this.incrementVectorClock();
    this.send({
      type: "request_full_sync",
      deviceId: this.settings.deviceId,
      timestamp: Date.now(),
      vectorClock: this.getVectorClockObject(),
      payload: null,
    });
  }

  private requestFile(path: string): void {
    this.incrementVectorClock();
    this.send({
      type: "request_file",
      deviceId: this.settings.deviceId,
      timestamp: Date.now(),
      vectorClock: this.getVectorClockObject(),
      payload: { path: path },
    });
  }

  queueFileChange(file: TFile): void {
    if (this.isProcessingRemote) return;

    const existing = this.pendingChanges.get(file.path);
    if (existing) clearTimeout(existing);

    this.pendingChanges.set(
      file.path,
      setTimeout(() => {
        void this.sendFileChange(file);
        this.pendingChanges.delete(file.path);
      }, this.settings.debounceMs)
    );
  }

  queueFileDelete(path: string): void {
    if (this.isProcessingRemote) return;

    const existing = this.pendingChanges.get(path);
    if (existing) clearTimeout(existing);

    this.pendingChanges.set(
      path,
      setTimeout(() => {
        this.sendFileDelete(path);
        this.pendingChanges.delete(path);
      }, this.settings.debounceMs)
    );
  }

  private async sendFileChange(file: TFile): Promise<void> {
    if (!this.isConnected()) return;

    try {
      const content = await this.app.vault.read(file);
      const hash = await this.hashContent(content);
      const previousHash = this.localHashes.get(file.path);

      this.localHashes.set(file.path, hash);

      const payload: FileChangePayload = {
        path: file.path,
        content: this.encodeBase64(content),
        mtime: file.stat.mtime,
        hash: hash,
        previousHash: previousHash,
      };

      this.incrementVectorClock();
      this.send({
        type: "file_change",
        deviceId: this.settings.deviceId,
        timestamp: Date.now(),
        vectorClock: this.getVectorClockObject(),
        payload: payload,
      });
    } catch (e) {
      console.error(`Vault Sync: Failed to send file change for ${file.path}:`, e);
    }
  }

  private sendFileDelete(path: string): void {
    if (!this.isConnected()) return;

    this.localHashes.delete(path);

    this.incrementVectorClock();
    this.send({
      type: "file_delete",
      deviceId: this.settings.deviceId,
      timestamp: Date.now(),
      vectorClock: this.getVectorClockObject(),
      payload: { path: path },
    });
  }

  queueFileMove(file: TFile, oldPath: string): void {
    if (this.isProcessingRemote) return;

    // Cancel any pending operations for both paths
    const existingOld = this.pendingChanges.get(oldPath);
    if (existingOld) clearTimeout(existingOld);
    const existingNew = this.pendingChanges.get(file.path);
    if (existingNew) clearTimeout(existingNew);

    this.pendingChanges.set(
      file.path,
      setTimeout(() => {
        void this.sendFileMove(file, oldPath);
        this.pendingChanges.delete(file.path);
      }, this.settings.debounceMs)
    );
  }

  private async sendFileMove(file: TFile, oldPath: string): Promise<void> {
    if (!this.isConnected()) return;

    try {
      const content = await this.app.vault.read(file);
      const hash = await this.hashContent(content);

      // Update hash cache
      this.localHashes.delete(oldPath);
      this.localHashes.set(file.path, hash);

      const payload: FileMovePayload = {
        oldPath: oldPath,
        newPath: file.path,
        content: this.encodeBase64(content),
        mtime: file.stat.mtime,
        hash: hash,
      };

      this.incrementVectorClock();
      this.send({
        type: "file_move",
        deviceId: this.settings.deviceId,
        timestamp: Date.now(),
        vectorClock: this.getVectorClockObject(),
        payload: payload,
      });

      console.debug(`Vault sync: Sent file move ${oldPath} -> ${file.path}`);
    } catch (e) {
      console.error(`Vault Sync: Failed to send file move for ${file.path}:`, e);
    }
  }

  private send(msg: SyncMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async handleServerMessage(msg: ServerMessage): Promise<void> {
    // Skip our own changes
    if (msg.originDevice === this.settings.deviceId) return;

    switch (msg.type) {
      case "file_changed":
        await this.handleRemoteFileChange(msg.payload as FileChangePayload);
        break;
      case "file_deleted":
        await this.handleRemoteFileDelete(msg.payload as FileDeletePayload);
        break;
      case "file_moved":
        await this.handleRemoteFileMove(msg.payload as FileMovePayload);
        break;
      case "full_sync":
        await this.handleFullSync(msg.payload as FullSyncPayload);
        break;
      case "conflict":
        this.handleConflict(msg.payload as ConflictPayload);
        break;
      case "pong":
        // Connection alive
        break;
    }
  }

  private async handleRemoteFileChange(payload: FileChangePayload): Promise<void> {
    this.isProcessingRemote = true;

    try {
      const content = this.decodeBase64(payload.content);
      const path = payload.path;

      // Ensure directory exists
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) {
        const existingFolder = this.app.vault.getAbstractFileByPath(dir);
        if (!existingFolder) {
          await this.app.vault.createFolder(dir);
        }
      }

      // Check if file exists
      const existingFile = this.app.vault.getAbstractFileByPath(path);

      if (existingFile instanceof TFile) {
        await this.app.vault.modify(existingFile, content);
      } else {
        await this.app.vault.create(path, content);
      }

      this.localHashes.set(path, payload.hash);
      console.debug(`Vault sync: Applied remote change to ${path}`);
    } catch (e) {
      console.error(`Vault Sync: Failed to apply remote change:`, e);
      new Notice(`Vault sync: failed to sync ${payload.path}`);
    } finally {
      this.isProcessingRemote = false;
    }
  }

  private async handleRemoteFileDelete(payload: FileDeletePayload): Promise<void> {
    this.isProcessingRemote = true;

    try {
      const file = this.app.vault.getAbstractFileByPath(payload.path);
      if (file) {
        await this.app.vault.delete(file);
        this.localHashes.delete(payload.path);
        console.debug(`Vault sync: Deleted ${payload.path}`);
      }
    } catch (e) {
      console.error(`Vault Sync: Failed to delete ${payload.path}:`, e);
    } finally {
      this.isProcessingRemote = false;
    }
  }

  private async handleRemoteFileMove(payload: FileMovePayload): Promise<void> {
    this.isProcessingRemote = true;

    try {
      const content = this.decodeBase64(payload.content);

      // Delete old file if exists
      const oldFile = this.app.vault.getAbstractFileByPath(payload.oldPath);
      if (oldFile) {
        await this.app.vault.delete(oldFile);
        this.localHashes.delete(payload.oldPath);
      }

      // Ensure directory exists for new path
      const dir = payload.newPath.substring(0, payload.newPath.lastIndexOf("/"));
      if (dir) {
        const existingFolder = this.app.vault.getAbstractFileByPath(dir);
        if (!existingFolder) {
          await this.app.vault.createFolder(dir);
        }
      }

      // Create new file
      const existingNew = this.app.vault.getAbstractFileByPath(payload.newPath);
      if (existingNew instanceof TFile) {
        await this.app.vault.modify(existingNew, content);
      } else {
        await this.app.vault.create(payload.newPath, content);
      }

      this.localHashes.set(payload.newPath, payload.hash);
      console.debug(`Vault sync: Applied remote move ${payload.oldPath} -> ${payload.newPath}`);
    } catch (e) {
      console.error(`Vault Sync: Failed to apply remote move:`, e);
      new Notice(`Vault sync: failed to move ${payload.oldPath}`);
    } finally {
      this.isProcessingRemote = false;
    }
  }

  private async handleFullSync(payload: FullSyncPayload): Promise<void> {
    try {
      // Merge server vector clock
      if (payload.vectorClock) {
        this.mergeVectorClock(payload.vectorClock);
      }

      new Notice(`Vault sync: syncing ${payload.files.length} files, ${payload.tombstones?.length || 0} tombstones...`);

      const serverFiles = new Map<string, FileInfo>();
      const serverHashToPath = new Map<string, string>();
      for (const f of payload.files) {
        serverFiles.set(f.path, f);
        serverHashToPath.set(f.hash, f.path);
      }

      // Build local file map
      const localFiles = this.app.vault.getFiles().filter(f => !f.path.startsWith("."));
      const localFileMap = new Map<string, TFile>();
      for (const file of localFiles) {
        localFileMap.set(file.path, file);
      }

      // Compute hashes for ALL local files (needed for move detection)
      // Use cached hashes when available
      const localHashToFile = new Map<string, TFile>();
      let hashCount = 0;
      for (const file of localFiles) {
        try {
          let hash = this.localHashes.get(file.path);
          if (!hash) {
            const content = await this.app.vault.read(file);
            hash = await this.hashContent(content);
            this.localHashes.set(file.path, hash);
          }
          localHashToFile.set(hash, file);
          hashCount++;
          // Yield every 50 files to prevent UI freeze on mobile
          if (hashCount % 50 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        } catch (e) {
          console.debug(`Vault sync: Could not hash ${file.path}`);
        }
      }

      // Find local files NOT on server
      const localOnlyFiles: TFile[] = [];
      for (const [path, file] of localFileMap) {
        if (!serverFiles.has(path)) {
          localOnlyFiles.push(file);
        }
      }

      let filesToDownload = 0;
      let filesToUpload = 0;
      let filesMoved = 0;

      // Files on server - check if we need to download or if it was moved
      for (const [serverPath, serverFile] of serverFiles) {
        const localFile = localFileMap.get(serverPath);

        if (!localFile) {
          // Check if file was moved (same hash exists locally at different path)
          const movedFile = localHashToFile.get(serverFile.hash);
          if (movedFile) {
            console.debug(`Vault sync: Detected move: ${serverPath} -> ${movedFile.path}`);
            this.sendFileDelete(serverPath);
            filesMoved++;
          } else {
            this.requestFile(serverPath);
            filesToDownload++;
          }
        } else {
          // File exists at same path - check mtime
          if (localFile.stat.mtime > serverFile.mtime) {
            void this.sendFileChange(localFile);
            filesToUpload++;
          } else if (localFile.stat.mtime < serverFile.mtime) {
            this.requestFile(serverPath);
            filesToDownload++;
          }
        }
      }

      // Process tombstones - delete files that were deleted on other devices
      let filesDeleted = 0;
      const tombstoneMap = new Map<string, Tombstone>();
      for (const tomb of payload.tombstones || []) {
        tombstoneMap.set(tomb.path, tomb);
      }

      // Local-only files: check tombstones, otherwise upload
      for (const file of localOnlyFiles) {
        const hash = this.localHashes.get(file.path);
        const serverPath = hash ? serverHashToPath.get(hash) : null;
        const tombstone = tombstoneMap.get(file.path);

        if (tombstone) {
          // File was deleted on another device - delete locally
          console.debug(`Vault sync: Deleting local file (tombstone): ${file.path}`);
          this.isProcessingRemote = true;
          try {
            await this.app.vault.delete(file);
            this.localHashes.delete(file.path);
            filesDeleted++;
          } catch (e) {
            console.error(`Vault sync: Failed to delete ${file.path}:`, e);
          } finally {
            this.isProcessingRemote = false;
          }
        } else if (serverPath && !localFileMap.has(serverPath)) {
          // File was moved: exists on server at different path, but that path doesn't exist locally
          // Upload this file to server (it will delete its old path)
          console.debug(`Vault sync: Uploading moved file: ${file.path} (was at ${serverPath} on server)`);
          void this.sendFileChange(file);
          filesToUpload++;
        } else {
          // File doesn't exist on server at all - UPLOAD IT (server may have lost files)
          console.debug(`Vault sync: Uploading local-only file: ${file.path}`);
          void this.sendFileChange(file);
          filesToUpload++;
        }
      }

      console.debug(`Vault sync: ↓${filesToDownload} ↑${filesToUpload} 🔄${filesMoved} 🗑${filesDeleted}`);
      new Notice(`Vault sync: ↓${filesToDownload} ↑${filesToUpload} 🔄${filesMoved} 🗑${filesDeleted}`);
    } catch (e) {
      console.error("Vault sync: Full sync error:", e);
      new Notice("Vault sync: sync failed");
    }
  }

  private handleConflict(payload: ConflictPayload): void {
    // For MVP, just notify the user
    new Notice(
      `Vault sync: conflict detected in ${payload.path}. Server version was used.`
    );
    console.warn("Vault Sync conflict:", payload);
  }

  private async hashContent(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private encodeBase64(str: string): string {
    // Handle Unicode properly
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private decodeBase64(base64: string): string {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }
}

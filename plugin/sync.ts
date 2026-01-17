import { App, TFile, Notice } from "obsidian";
import { VaultSyncSettings } from "./settings";

// Message types
export interface SyncMessage {
  type: "file_change" | "file_delete" | "request_full_sync" | "request_file" | "ping";
  deviceId: string;
  timestamp: number;
  payload: FileChangePayload | FileDeletePayload | RequestFilePayload | null;
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

export interface ServerMessage {
  type: "file_changed" | "file_deleted" | "full_sync" | "conflict" | "pong";
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
  private pendingChanges: Map<string, NodeJS.Timeout> = new Map();
  private localHashes: Map<string, string> = new Map();
  private isProcessingRemote = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  onConnectionChange: ((connected: boolean) => void) | null = null;

  constructor(app: App, settings: VaultSyncSettings) {
    this.app = app;
    this.settings = settings;
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
      new Notice("Vault Sync: Server URL and token are required");
      return;
    }

    const url = new URL(this.settings.serverUrl);
    url.searchParams.set("token", this.settings.token);
    url.searchParams.set("device_id", this.settings.deviceId);

    try {
      this.ws = new WebSocket(url.toString());
    } catch (e) {
      new Notice(`Vault Sync: Failed to create WebSocket: ${e}`);
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      new Notice("Vault Sync: Connected");
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
        new Notice(`Vault Sync: Reconnecting in ${delay / 1000}s...`);
        this.reconnectTimeout = setTimeout(() => this.connect(), delay);
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        new Notice("Vault Sync: Max reconnect attempts reached");
      }
    };

    this.ws.onerror = (error) => {
      console.error("Vault Sync WebSocket error:", error);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        this.handleServerMessage(msg);
      } catch (e) {
        console.error("Vault Sync: Failed to parse message:", e);
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

    new Notice("Vault Sync: Disconnected");
    this.onConnectionChange?.(false);
  }

  requestFullSync(): void {
    this.send({
      type: "request_full_sync",
      deviceId: this.settings.deviceId,
      timestamp: Date.now(),
      payload: null,
    });
  }

  private requestFile(path: string): void {
    this.send({
      type: "request_file",
      deviceId: this.settings.deviceId,
      timestamp: Date.now(),
      payload: { path: path },
    });
  }

  async queueFileChange(file: TFile): Promise<void> {
    if (this.isProcessingRemote) return;

    const existing = this.pendingChanges.get(file.path);
    if (existing) clearTimeout(existing);

    this.pendingChanges.set(
      file.path,
      setTimeout(async () => {
        await this.sendFileChange(file);
        this.pendingChanges.delete(file.path);
      }, this.settings.debounceMs)
    );
  }

  async queueFileDelete(path: string): Promise<void> {
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

      this.send({
        type: "file_change",
        deviceId: this.settings.deviceId,
        timestamp: Date.now(),
        payload: payload,
      });
    } catch (e) {
      console.error(`Vault Sync: Failed to send file change for ${file.path}:`, e);
    }
  }

  private sendFileDelete(path: string): void {
    if (!this.isConnected()) return;

    this.localHashes.delete(path);

    this.send({
      type: "file_delete",
      deviceId: this.settings.deviceId,
      timestamp: Date.now(),
      payload: { path: path },
    });
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
      console.log(`Vault Sync: Applied remote change to ${path}`);
    } catch (e) {
      console.error(`Vault Sync: Failed to apply remote change:`, e);
      new Notice(`Vault Sync: Failed to sync ${payload.path}`);
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
        console.log(`Vault Sync: Deleted ${payload.path}`);
      }
    } catch (e) {
      console.error(`Vault Sync: Failed to delete ${payload.path}:`, e);
    } finally {
      this.isProcessingRemote = false;
    }
  }

  private async handleFullSync(payload: FullSyncPayload): Promise<void> {
    new Notice(`Vault Sync: Syncing ${payload.files.length} files...`);

    const serverFiles = new Set(payload.files.map((f) => f.path));

    // Build local file list
    const localFiles = this.app.vault.getFiles();
    const localFileMap = new Map<string, TFile>();
    for (const file of localFiles) {
      localFileMap.set(file.path, file);
    }

    let filesToDownload = 0;
    let filesToUpload = 0;

    // Process server files
    for (const serverFile of payload.files) {
      const localFile = localFileMap.get(serverFile.path);

      if (!localFile) {
        // File exists on server but not locally - request it
        this.requestFile(serverFile.path);
        filesToDownload++;
        continue;
      }

      // Update local hash cache
      const content = await this.app.vault.read(localFile);
      const localHash = await this.hashContent(content);
      this.localHashes.set(serverFile.path, localHash);

      // If hashes differ, compare mtime to decide direction
      if (localHash !== serverFile.hash) {
        if (localFile.stat.mtime > serverFile.mtime) {
          // Local is newer - send to server
          await this.sendFileChange(localFile);
          filesToUpload++;
        } else {
          // Server is newer - request from server
          this.requestFile(serverFile.path);
          filesToDownload++;
        }
      }
    }

    // Send files that exist locally but not on server
    for (const [path, file] of localFileMap) {
      if (!serverFiles.has(path) && !path.startsWith(".")) {
        await this.sendFileChange(file);
        filesToUpload++;
      }
    }

    console.log(`Vault Sync: Requesting ${filesToDownload} files, uploading ${filesToUpload} files`);
    new Notice(`Vault Sync: Downloading ${filesToDownload}, uploading ${filesToUpload}`);
  }

  private handleConflict(payload: ConflictPayload): void {
    // For MVP, just notify the user
    new Notice(
      `Vault Sync: Conflict detected in ${payload.path}. Server version was used.`
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

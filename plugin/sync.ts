import { App, TFile, Notice, Platform } from "obsidian";
import { VaultSyncSettings } from "./settings";

export interface FileInfo {
  path: string;
  hash: string;
  size: number;
  mtime: number;
}

export interface Tombstone {
  path: string;
  deletedAt: number;
  deletedBy: string;
  ttl: number;
}

interface SSEEvent {
  type: string;
  path?: string;
  hash?: string;
  mtime?: number;
  size?: number;
}

export class SyncManager {
  private app: App;
  private settings: VaultSyncSettings;
  private eventSource: EventSource | null = null;
  private pendingChanges: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private localHashes: Map<string, string> = new Map();
  private isProcessingRemote = false;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private shouldReconnect = true;

  // Persistent pending deletes - files that need to be deleted on server
  private pendingDeletes: Set<string> = new Set();

  onConnectionChange: ((connected: boolean) => void) | null = null;

  constructor(app: App, settings: VaultSyncSettings) {
    this.app = app;
    this.settings = settings;
  }

  updateSettings(settings: VaultSyncSettings) {
    this.settings = settings;
  }

  isConnected(): boolean {
    return this.eventSource !== null && this.eventSource.readyState === EventSource.OPEN;
  }

  // Whitelist of .obsidian files safe to sync
  private readonly obsidianWhitelist = [
    '.obsidian/hotkeys.json',
    '.obsidian/appearance.json',
    '.obsidian/community-plugins.json',
    '.obsidian/core-plugins.json',
    '.obsidian/templates.json',
    '.obsidian/bookmarks.json',
    '.obsidian/snippets/',
  ];

  // Check if file is a temp/hidden file that should not be synced
  private isTempFile(path: string): boolean {
    const filename = path.split('/').pop() || '';
    // Exclude files starting with . (hidden/temp files)
    if (filename.startsWith('.')) return true;
    // Exclude common temp patterns
    if (filename.includes('.tmp') || filename.includes('.temp')) return true;
    if (filename.includes('.sync-conflict-')) return true;
    return false;
  }

  private shouldSyncFile(path: string): boolean {
    // Exclude temp/hidden files
    if (this.isTempFile(path)) return false;

    // Check .obsidian files against whitelist
    if (path.startsWith('.obsidian/')) {
      // Allow whitelisted files/folders
      for (const allowed of this.obsidianWhitelist) {
        if (path === allowed || path.startsWith(allowed)) {
          return true;
        }
      }
      return false;
    }

    // Exclude other hidden directories
    if (path.includes('/.')) return false;

    const excludePatterns = ['.git/', '.DS_Store', 'Thumbs.db', '.tmp', '.temp'];
    for (const pattern of excludePatterns) {
      if (path.includes(pattern)) return false;
    }
    return true;
  }

  private getBaseUrl(): string {
    // Convert serverUrl to HTTP base URL
    // e.g., "http://90.156.230.49:8080" -> "http://90.156.230.49:8080"
    return this.settings.serverUrl.replace(/\/+$/, '');
  }

  connect(): void {
    this.shouldReconnect = true;

    if (this.eventSource && this.eventSource.readyState === EventSource.OPEN) {
      console.log('[Vault Sync] Already connected');
      return;
    }

    if (this.eventSource) {
      this.eventSource.close();
    }

    if (!this.settings.serverUrl || !this.settings.token) {
      new Notice("Vault sync: server URL and token are required");
      return;
    }

    const baseUrl = this.getBaseUrl();
    const sseUrl = `${baseUrl}/api/events?token=${encodeURIComponent(this.settings.token)}&device_id=${encodeURIComponent(this.settings.deviceId)}`;

    try {
      this.eventSource = new EventSource(sseUrl);
    } catch (e) {
      new Notice(`Vault sync: failed to connect: ${e}`);
      return;
    }

    this.eventSource.onopen = () => {
      console.log('[Vault Sync] SSE connected');
      this.reconnectAttempts = 0;

      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }

      new Notice("Vault sync: connected");
      this.onConnectionChange?.(true);

      // Request full sync on connect
      if (this.settings.syncOnStart) {
        console.log('[Vault Sync] Starting initial full sync');
        void this.requestFullSync().then(() => {
          console.log('[Vault Sync] Initial full sync completed');
        }).catch((e) => {
          console.error('[Vault Sync] Initial full sync failed:', e);
        });
      }
    };

    this.eventSource.onerror = (e) => {
      console.error('[Vault Sync] SSE error/closed', e);
      console.error('[Vault Sync] EventSource readyState:', this.eventSource?.readyState);
      this.onConnectionChange?.(false);

      // Reconnect quickly - max 5 seconds delay for real-time sync
      if (this.shouldReconnect) {
        const delay = Math.min(1000 * (this.reconnectAttempts + 1), 5000);
        this.reconnectAttempts++;
        console.log(`[Vault Sync] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        this.reconnectTimeout = setTimeout(() => this.connect(), delay);
      }
    };

    // Handle SSE events
    this.eventSource.addEventListener('connected', (event) => {
      console.log('[Vault Sync] SSE connected event:', event.data);
    });

    this.eventSource.addEventListener('file_changed', (event) => {
      try {
        const data: SSEEvent = JSON.parse(event.data);
        console.log('[Vault Sync] File changed on server:', data.path);
        void this.downloadFile(data.path!);
      } catch (e) {
        console.error('[Vault Sync] Failed to parse file_changed event:', e);
      }
    });

    this.eventSource.addEventListener('file_deleted', (event) => {
      try {
        const data: SSEEvent = JSON.parse(event.data);
        console.log('[Vault Sync] File deleted on server:', data.path);
        void this.handleRemoteDelete(data.path!);
      } catch (e) {
        console.error('[Vault Sync] Failed to parse file_deleted event:', e);
      }
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    new Notice("Vault sync: disconnected");
    this.onConnectionChange?.(false);
  }

  async requestFullSync(): Promise<void> {
    try {
      const baseUrl = this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/list`, {
        headers: {
          'X-Auth-Token': this.settings.token,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      await this.handleFullSync(data.files || [], data.tombstones || []);
    } catch (e) {
      console.error('[Vault Sync] Full sync failed:', e);
      new Notice(`Vault sync: sync failed - ${e}`);
    }
  }

  private async handleFullSync(serverFiles: FileInfo[], tombstones: Tombstone[]): Promise<void> {
    try {
      new Notice(`Vault sync: syncing ${serverFiles.length} files...`);

      const serverFileMap = new Map<string, FileInfo>();
      const serverHashToPath = new Map<string, string>();
      for (const f of serverFiles) {
        serverFileMap.set(f.path, f);
        serverHashToPath.set(f.hash, f.path);
      }

      // Build local file map
      const localFiles = this.app.vault.getFiles().filter(f => this.shouldSyncFile(f.path));
      const localFileMap = new Map<string, TFile>();
      for (const file of localFiles) {
        localFileMap.set(file.path, file);
      }

      // Also sync .obsidian whitelist files via adapter (skip on mobile for now)
      if (!Platform.isMobile) {
        try {
          await this.syncObsidianConfigs(serverFileMap);
        } catch (e) {
          console.error('[Vault Sync] syncObsidianConfigs failed:', e);
        }
      }

      // Find local files NOT on server
      const localOnlyFiles: TFile[] = [];
      for (const [path, file] of localFileMap) {
        if (!serverFileMap.has(path)) {
          localOnlyFiles.push(file);
        }
      }

      let filesToDownload = 0;
      let filesToUpload = 0;
      let filesDeleted = 0;

      // First: process pending deletes (files deleted locally while offline)
      if (this.pendingDeletes.size > 0) {
        console.log(`[Vault Sync] Processing ${this.pendingDeletes.size} pending deletes`);
        for (const path of [...this.pendingDeletes]) {
          if (serverFileMap.has(path)) {
            console.log(`[Vault Sync] Deleting pending: ${path}`);
            await this.deleteFileOnServer(path);
            filesDeleted++;
          } else {
            // File already gone from server
            this.pendingDeletes.delete(path);
          }
        }
      }

      // Files on server - check if we need to download/upload based on mtime
      for (const [serverPath, serverFile] of serverFileMap) {
        // Skip if we just deleted this file or it's pending delete
        if (this.pendingDeletes.has(serverPath)) {
          continue;
        }

        const localFile = localFileMap.get(serverPath);

        if (!localFile) {
          // File doesn't exist locally - download from server
          await this.downloadFile(serverPath);
          filesToDownload++;
        } else {
          // File exists - compare mtime to decide sync direction
          // Use 1-second tolerance for mtime comparison
          const localMtime = Math.floor(localFile.stat.mtime / 1000);
          const serverMtime = Math.floor(serverFile.mtime / 1000);

          if (localMtime > serverMtime) {
            // Local is newer - upload
            console.log(`[Vault Sync] Local file is newer, uploading: ${localFile.path}`);
            try {
              await this.uploadFile(localFile, true);
              filesToUpload++;
            } catch (e) {
              console.error(`[Vault Sync] Failed to upload ${localFile.path}:`, e);
            }
          } else if (serverMtime > localMtime) {
            // Server is newer - download
            await this.downloadFile(serverPath);
            filesToDownload++;
          }
          // If mtime is equal - files are in sync, skip
        }
      }

      // Process tombstones
      const tombstoneMap = new Map<string, Tombstone>();
      for (const tomb of tombstones) {
        tombstoneMap.set(tomb.path, tomb);
      }

      // Local-only files: check tombstones, otherwise upload
      for (const file of localOnlyFiles) {
        const tombstone = tombstoneMap.get(file.path);

        if (tombstone) {
          console.debug(`[Vault Sync] Deleting local file (tombstone): ${file.path}`);
          this.isProcessingRemote = true;
          try {
            await this.app.vault.delete(file);
            this.localHashes.delete(file.path);
            filesDeleted++;
          } catch (e) {
            console.error(`[Vault Sync] Failed to delete ${file.path}:`, e);
          } finally {
            this.isProcessingRemote = false;
          }
        } else {
          // Upload to server
          console.log(`[Vault Sync] Uploading local-only file: ${file.path}`);
          try {
            await this.uploadFile(file, true);
            filesToUpload++;
          } catch (e) {
            console.error(`[Vault Sync] Failed to upload ${file.path}:`, e);
          }
        }
      }

      console.log(`[Vault Sync] Sync complete: ${filesToDownload} down, ${filesToUpload} up, ${filesDeleted} deleted`);
      new Notice(`Vault sync: ${filesToDownload} ${filesToUpload} ${filesDeleted}`);

    } catch (e) {
      console.error('[Vault Sync] Full sync error:', e);
      new Notice("Vault sync: sync failed");
    }
  }

  queueFileChange(file: TFile): void {
    if (this.isProcessingRemote) return;
    if (!this.shouldSyncFile(file.path)) return;

    const existing = this.pendingChanges.get(file.path);
    if (existing) clearTimeout(existing);

    this.pendingChanges.set(
      file.path,
      setTimeout(() => {
        void this.uploadFile(file);
        this.pendingChanges.delete(file.path);
      }, this.settings.debounceMs)
    );
  }

  queueFileDelete(path: string): void {
    if (this.isProcessingRemote) return;
    if (!this.shouldSyncFile(path)) return;

    // Always track deletion - even if offline, we'll sync on reconnect
    this.pendingDeletes.add(path);

    const existing = this.pendingChanges.get(path);
    if (existing) clearTimeout(existing);

    this.pendingChanges.set(
      path,
      setTimeout(() => {
        void this.deleteFileOnServer(path);
        this.pendingChanges.delete(path);
      }, this.settings.debounceMs)
    );
  }

  queueFileMove(file: TFile, oldPath: string): void {
    if (this.isProcessingRemote) return;

    // Cancel pending operations for both paths
    const existingOld = this.pendingChanges.get(oldPath);
    if (existingOld) clearTimeout(existingOld);
    const existingNew = this.pendingChanges.get(file.path);
    if (existingNew) clearTimeout(existingNew);

    this.pendingChanges.set(
      file.path,
      setTimeout(() => {
        // Delete old path on server, upload new file
        void this.deleteFileOnServer(oldPath);
        void this.uploadFile(file);
        this.pendingChanges.delete(file.path);
      }, this.settings.debounceMs)
    );
  }

  private async uploadFile(file: TFile, force = false): Promise<void> {
    if (!this.isConnected()) {
      console.warn(`[Vault Sync] Cannot upload ${file.path}, not connected`);
      return;
    }

    try {
      const content = await this.app.vault.readBinary(file);
      const hash = await this.hashBinaryContent(content);

      // Check if hash changed (skip check if force=true for full sync)
      if (!force) {
        const oldHash = this.localHashes.get(file.path);
        if (oldHash === hash) {
          console.debug(`[Vault Sync] Skip upload ${file.path} - hash unchanged`);
          return;
        }
      }

      const formData = new FormData();
      formData.append('path', file.path);
      formData.append('mtime', String(file.stat.mtime));
      formData.append('hash', hash);
      formData.append('file', new Blob([content]), file.name);

      const baseUrl = this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/upload?device_id=${encodeURIComponent(this.settings.deviceId)}`, {
        method: 'POST',
        headers: {
          'X-Auth-Token': this.settings.token,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.localHashes.set(file.path, hash);
      console.debug(`[Vault Sync] Uploaded ${file.path}`);
    } catch (e) {
      console.error(`[Vault Sync] Failed to upload ${file.path}:`, e);
    }
  }

  private async downloadFile(path: string): Promise<void> {
    try {
      const baseUrl = this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/download/${encodeURIComponent(path)}`, {
        headers: {
          'X-Auth-Token': this.settings.token,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const content = await response.arrayBuffer();
      const hash = response.headers.get('X-File-Hash') || '';

      this.isProcessingRemote = true;
      try {
        // Use adapter for .obsidian files, vault API for others
        if (path.startsWith('.obsidian/')) {
          const adapter = this.app.vault.adapter;
          const dir = path.substring(0, path.lastIndexOf("/"));
          if (dir && !(await adapter.exists(dir))) {
            await adapter.mkdir(dir);
          }
          await adapter.writeBinary(path, content);
        } else {
          // Ensure directory exists
          const dir = path.substring(0, path.lastIndexOf("/"));
          if (dir) {
            const existingFolder = this.app.vault.getAbstractFileByPath(dir);
            if (!existingFolder) {
              await this.app.vault.createFolder(dir);
            }
          }

          // Create or update file
          const existingFile = this.app.vault.getAbstractFileByPath(path);
          if (existingFile instanceof TFile) {
            await this.app.vault.modifyBinary(existingFile, content);
          } else {
            await this.app.vault.createBinary(path, content);
          }
        }

        this.localHashes.set(path, hash);
        console.debug(`[Vault Sync] Downloaded ${path}`);
      } finally {
        this.isProcessingRemote = false;
      }
    } catch (e) {
      console.error(`[Vault Sync] Failed to download ${path}:`, e);
    }
  }

  private async deleteFileOnServer(path: string): Promise<void> {
    if (!this.isConnected()) {
      console.warn(`[Vault Sync] Cannot delete ${path}, not connected. Will retry on reconnect.`);
      // pendingDeletes already has this path from queueFileDelete
      return;
    }

    try {
      const baseUrl = this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/delete/${encodeURIComponent(path)}?device_id=${encodeURIComponent(this.settings.deviceId)}`, {
        method: 'DELETE',
        headers: {
          'X-Auth-Token': this.settings.token,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Success - remove from pending
      this.pendingDeletes.delete(path);
      this.localHashes.delete(path);
      console.log(`[Vault Sync] Deleted on server: ${path}`);
    } catch (e) {
      console.error(`[Vault Sync] Failed to delete ${path}:`, e);
      // Keep in pendingDeletes for retry
    }
  }

  private async handleRemoteDelete(path: string): Promise<void> {
    this.isProcessingRemote = true;
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) {
        await this.app.vault.delete(file);
        this.localHashes.delete(path);
        console.debug(`[Vault Sync] Deleted locally: ${path}`);
      }
    } catch (e) {
      console.error(`[Vault Sync] Failed to delete ${path}:`, e);
    } finally {
      this.isProcessingRemote = false;
    }
  }

  private async hashContent(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async hashBinaryContent(content: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", content);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Sync .obsidian config files using adapter (not part of vault.getFiles())
  private async syncObsidianConfigs(serverFileMap: Map<string, FileInfo>): Promise<void> {
    const adapter = this.app.vault.adapter;

    for (const allowedPath of this.obsidianWhitelist) {
      try {
        if (allowedPath.endsWith('/')) {
          // It's a directory - list and sync all files in it
          const dirPath = allowedPath.slice(0, -1);
          if (await adapter.exists(dirPath)) {
            const listing = await adapter.list(dirPath);
            for (const filePath of listing.files) {
              await this.syncConfigFile(filePath, serverFileMap);
            }
          }
        } else {
          // It's a single file
          if (await adapter.exists(allowedPath)) {
            await this.syncConfigFile(allowedPath, serverFileMap);
          }
        }
      } catch (e) {
        console.debug(`[Vault Sync] Could not sync ${allowedPath}:`, e);
      }
    }
  }

  private async syncConfigFile(path: string, serverFileMap: Map<string, FileInfo>): Promise<void> {
    // Skip temp/hidden files
    if (this.isTempFile(path)) {
      console.debug(`[Vault Sync] Skipping temp file: ${path}`);
      return;
    }

    const adapter = this.app.vault.adapter;
    const content = await adapter.readBinary(path);
    const hash = await this.hashBinaryContent(content);
    const stat = await adapter.stat(path);
    const mtime = stat?.mtime || Date.now();

    const serverFile = serverFileMap.get(path);

    if (!serverFile) {
      // Upload to server
      console.log(`[Vault Sync] Uploading config: ${path}`);
      await this.uploadConfigFile(path, content, hash, mtime);
    } else if (serverFile.hash !== hash) {
      // Hash mismatch - sync based on mtime
      if (mtime > serverFile.mtime) {
        console.log(`[Vault Sync] Config is newer locally, uploading: ${path}`);
        await this.uploadConfigFile(path, content, hash, mtime);
      } else {
        console.log(`[Vault Sync] Config is newer on server, downloading: ${path}`);
        await this.downloadFile(path);
      }
    }
    // If hashes match, no action needed
  }

  private async uploadConfigFile(path: string, content: ArrayBuffer, hash: string, mtime: number): Promise<void> {
    if (!this.isConnected()) {
      console.warn(`[Vault Sync] Cannot upload config ${path}, not connected`);
      return;
    }

    try {
      const formData = new FormData();
      formData.append('path', path);
      formData.append('mtime', String(mtime));
      formData.append('hash', hash);
      formData.append('file', new Blob([content]), path.split('/').pop() || 'config');

      const baseUrl = this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/upload?device_id=${encodeURIComponent(this.settings.deviceId)}`, {
        method: 'POST',
        headers: {
          'X-Auth-Token': this.settings.token,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.localHashes.set(path, hash);
      console.debug(`[Vault Sync] Uploaded config ${path}`);
    } catch (e) {
      console.error(`[Vault Sync] Failed to upload config ${path}:`, e);
    }
  }
}

import { App, Notice, TFile, TAbstractFile, requestUrl } from 'obsidian';
import { StompClient } from './StompClient';
import { FileWatcher, FileChange } from './FileWatcher';
import { LocalState } from '../storage/LocalState';
import {
  VaultSyncSettings,
  ServerMessage,
  FileChangedMessage,
  FileDeletedMessage,
  SyncResponse,
  PendingOperation,
  ConnectionState,
} from '../types';

export class SyncManager {
  private app: App;
  private settings: VaultSyncSettings;
  private stompClient: StompClient;
  private fileWatcher: FileWatcher;
  private localState: LocalState;

  private pendingChanges: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private isProcessingRemote = false;
  private connectionState: ConnectionState = 'disconnected';

  onConnectionChange?: (connected: boolean) => void;

  constructor(app: App, settings: VaultSyncSettings) {
    this.app = app;
    this.settings = settings;
    this.stompClient = new StompClient();
    this.localState = new LocalState();
    this.fileWatcher = new FileWatcher(app, this.localState);

    // Set up message handlers
    this.stompClient.setMessageHandler((msg) => this.handleServerMessage(msg));
    this.stompClient.setConnectionHandler((state) => this.handleConnectionChange(state));

    // Set up file watcher handler for external FS changes
    this.fileWatcher.onChangesDetected = (changes) => this.handleFileWatcherChanges(changes);
  }

  async init(): Promise<void> {
    await this.localState.init();
    // Start file watcher (scans every 10 seconds for external changes)
    this.fileWatcher.start(10000);
  }

  async connect(): Promise<void> {
    if (this.connectionState === 'connected' || this.connectionState === 'connecting') {
      return;
    }

    try {
      await this.stompClient.connect(
        this.settings.serverUrl,
        this.settings.token,
        this.settings.deviceId
      );

      if (this.settings.syncOnStart) {
        await this.requestFullSync();
      }

      // Process any pending operations from offline queue
      await this.processPendingOperations();

    } catch (e) {
      console.error('[VaultSync] Connection failed:', e);
      new Notice('Vault Sync: Connection failed');
    }
  }

  disconnect(): void {
    this.stompClient.disconnect();
  }

  isConnected(): boolean {
    return this.stompClient.isConnected();
  }

  private handleConnectionChange(state: ConnectionState): void {
    this.connectionState = state;

    if (state === 'connected') {
      new Notice('Vault Sync: Connected');
      this.onConnectionChange?.(true);
    } else if (state === 'disconnected') {
      this.onConnectionChange?.(false);
    }
  }

  private async handleServerMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case 'file_changed':
        await this.handleRemoteFileChange(message as FileChangedMessage);
        break;
      case 'file_deleted':
        await this.handleRemoteFileDelete(message as FileDeletedMessage);
        break;
    }
  }

  private async handleRemoteFileChange(msg: FileChangedMessage): Promise<void> {
    this.isProcessingRemote = true;
    try {
      const success = await this.downloadFile(msg.path);
      if (success) {
        await this.localState.setLastSeq(msg.seq);
      } else {
        console.error(`[VaultSync] Remote file change failed to download: ${msg.path}`);
      }
    } finally {
      this.isProcessingRemote = false;
    }
  }

  private async handleRemoteFileDelete(msg: FileDeletedMessage): Promise<void> {
    this.isProcessingRemote = true;
    try {
      const file = this.app.vault.getAbstractFileByPath(msg.path);
      if (file instanceof TFile) {
        await this.app.vault.delete(file);
      }
      await this.localState.deleteFileHash(msg.path);
      await this.localState.setLastSeq(msg.seq);
      // Update file watcher baseline
      this.fileWatcher.removeFromBaseline(msg.path);
    } catch (e) {
      console.error(`[VaultSync] Failed to delete ${msg.path}:`, e);
    } finally {
      this.isProcessingRemote = false;
    }
  }

  // Handle external file system changes detected by FileWatcher
  private handleFileWatcherChanges(changes: FileChange[]): void {
    if (this.isProcessingRemote) return;

    console.debug(`[VaultSync] FileWatcher detected ${changes.length} external changes`);

    for (const change of changes) {
      switch (change.type) {
        case 'create':
        case 'modify':
          if (change.file) {
            this.queueFileChange(change.file);
          }
          break;
        case 'delete':
          this.queueFileDelete(change.path);
          break;
      }
    }
  }

  // File change detection
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

    const existing = this.pendingChanges.get(path);
    if (existing) clearTimeout(existing);

    this.pendingChanges.set(
      path,
      setTimeout(() => {
        void this.deleteFile(path);
        this.pendingChanges.delete(path);
      }, this.settings.debounceMs)
    );
  }

  queueFileRename(file: TFile, oldPath: string): void {
    if (this.isProcessingRemote) return;

    // Delete old, upload new
    this.queueFileDelete(oldPath);
    this.queueFileChange(file);
  }

  // File operations
  private async uploadFile(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.readBinary(file);
      const hash = await this.computeHash(content);

      // Check if hash changed
      const existingHash = await this.localState.getFileHash(file.path);
      if (existingHash === hash) {
        return; // No change
      }

      if (!this.isConnected()) {
        await this.queuePendingOperation('upload', file.path);
        return;
      }

      // Upload via HTTP - use requestUrl for CORS bypass
      const baseUrl = this.settings.serverUrl.replace('/ws', '').replace('wss://', 'https://').replace('ws://', 'http://');

      // Convert ArrayBuffer to base64 for JSON upload
      const base64Content = this.arrayBufferToBase64(content);

      const response = await requestUrl({
        url: `${baseUrl}/api/upload-json`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': this.settings.token,
          'X-Device-Id': this.settings.deviceId,
        },
        body: JSON.stringify({
          path: file.path,
          content: base64Content,
          hash: hash,
          mtime: file.stat.mtime,
        }),
      });

      if (response.status !== 200) {
        throw new Error(`Upload failed: ${response.status}`);
      }

      await this.localState.setFileHash(file.path, hash);

    } catch (e) {
      console.error(`[VaultSync] Upload failed for ${file.path}:`, e);
      await this.queuePendingOperation('upload', file.path);
    }
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Encode path for URL while preserving slashes
  private encodePathForUrl(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  private async downloadFile(path: string, retries = 3): Promise<boolean> {
    console.debug(`[VaultSync] downloadFile starting: ${path}`);
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const baseUrl = this.settings.serverUrl.replace('/ws', '').replace('wss://', 'https://').replace('ws://', 'http://');
        const encodedPath = this.encodePathForUrl(path);
        const url = `${baseUrl}/api/download/${encodedPath}`;

        // Use Obsidian's requestUrl to bypass CORS
        const response = await requestUrl({
          url: url,
          method: 'GET',
          headers: {
            'X-Auth-Token': this.settings.token,
            'X-Device-Id': this.settings.deviceId,
          },
        });

        if (response.status !== 200) {
          throw new Error(`Download failed: ${response.status}`);
        }

        const content = response.arrayBuffer;
        const hash = response.headers['x-file-hash'] || response.headers['X-File-Hash'] || '';

        // Ensure parent directories exist
        const dir = path.substring(0, path.lastIndexOf('/'));
        if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
          await this.createFolderRecursively(dir);
        }

        // Write file
        const existingFile = this.app.vault.getAbstractFileByPath(path);
        if (existingFile instanceof TFile) {
          await this.app.vault.modifyBinary(existingFile, content);
        } else {
          await this.app.vault.createBinary(path, content);
        }

        await this.localState.setFileHash(path, hash);

        // Update file watcher baseline so it doesn't detect this as external change
        const updatedFile = this.app.vault.getAbstractFileByPath(path) as TFile;
        if (updatedFile) {
          this.fileWatcher.markProcessed(path, updatedFile.stat.mtime, updatedFile.stat.size);
        }

        return true; // Success

      } catch (e: any) {
        console.error(`[VaultSync] Download attempt ${attempt}/${retries} failed for ${path}:`, e);
        if (attempt < retries) {
          await this.sleep(1000 * attempt);
        }
      }
    }
    return false; // All retries failed
  }

  private async createFolderRecursively(path: string): Promise<void> {
    const parts = path.split('/');
    let currentPath = '';
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);
      if (!existing) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch (e: any) {
          // Ignore "folder already exists" errors (race condition with parallel downloads)
          const msg = e?.message?.toLowerCase() || '';
          if (!msg.includes('already exists') && !msg.includes('folder exists')) {
            // Check again if folder exists now - if yes, it's fine
            if (!this.app.vault.getAbstractFileByPath(currentPath)) {
              throw e;
            }
          }
        }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async deleteFile(path: string): Promise<void> {
    try {
      if (!this.isConnected()) {
        await this.queuePendingOperation('delete', path);
        return;
      }

      const baseUrl = this.settings.serverUrl.replace('/ws', '').replace('wss://', 'https://').replace('ws://', 'http://');

      // Use requestUrl for CORS bypass
      const response = await requestUrl({
        url: `${baseUrl}/api/delete-json`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': this.settings.token,
          'X-Device-Id': this.settings.deviceId,
        },
        body: JSON.stringify({ path }),
      });

      if (response.status !== 200) {
        throw new Error(`Delete failed: ${response.status}`);
      }

      await this.localState.deleteFileHash(path);

    } catch (e) {
      console.error(`[VaultSync] Delete failed for ${path}:`, e);
      await this.queuePendingOperation('delete', path);
    }
  }

  // Full sync - ALWAYS request ALL files (lastSeq=0) to ensure complete sync
  async requestFullSync(): Promise<void> {
    if (!this.isConnected()) {
      new Notice('Vault Sync: Not connected');
      return;
    }

    try {
      new Notice('Vault Sync: Syncing...');
      // Always request full state (lastSeq=0) to get ALL files from server
      // This ensures we don't miss any files that were created while offline
      const response = await this.stompClient.requestSync(0);

      await this.processFullSync(response);
      await this.localState.setLastSeq(response.currentSeq);

      new Notice('Vault Sync: Sync complete');
    } catch (e) {
      console.error('[VaultSync] Full sync failed:', e);
      new Notice('Vault Sync: Sync failed');
    }
  }

  private async processFullSync(response: SyncResponse): Promise<void> {
    try {
      const files = response.files || [];
      const tombstoneList = response.tombstones || [];

      console.debug(`[VaultSync] Full sync received: ${files.length} files, ${tombstoneList.length} tombstones, currentSeq=${response.currentSeq}`);
      new Notice(`Sync: Server has ${files.length} files`);

      // Debug: write to file
      const debugContent = `Full sync received at ${new Date().toISOString()}\nServer files: ${files.length}\nTombstones: ${tombstoneList.length}\ncurrentSeq: ${response.currentSeq}\n`;
      try {
        const debugFile = this.app.vault.getAbstractFileByPath('_sync_debug.txt');
        if (debugFile) {
          await this.app.vault.adapter.append('_sync_debug.txt', debugContent);
        } else {
          await this.app.vault.create('_sync_debug.txt', debugContent);
        }
      } catch (e) {
        console.error('[VaultSync] Debug file write failed:', e);
      }

    const serverFiles = new Map(files.map(f => [f.path, f]));
    const tombstones = new Set(tombstoneList.map(t => t.path));

    // Get local files
    const localFiles = this.app.vault.getFiles().filter(f => this.shouldSyncFile(f.path));
    const localHashes = await this.localState.getAllHashes();

    console.debug(`[VaultSync] Local state: ${localFiles.length} files, ${localHashes.size} hashes`);
    new Notice(`Local: ${localFiles.length} files`);

    // Debug: count server files not on local
    let missingCount = 0;
    const missingPaths: string[] = [];
    for (const [path] of serverFiles) {
      const localFile = this.app.vault.getAbstractFileByPath(path);
      if (!localFile) {
        missingCount++;
        if (missingPaths.length < 3) {
          missingPaths.push(path);
        }
      }
    }
    console.debug(`[VaultSync] DEBUG: ${missingCount} files on server but not local`);
    if (missingCount > 0) {
      console.debug(`[VaultSync] DEBUG: Missing examples: ${missingPaths.join(', ')}`);
      new Notice(`Sync: Need to download ${missingCount} files`);
    }

    let downloaded = 0;
    let downloadFailed = 0;
    let uploaded = 0;
    let uploadFailed = 0;
    let deleted = 0;

    // Collect files to download
    const toDownload: { path: string; serverFile: { hash: string; mtime: number } }[] = [];

    for (const [path, serverFile] of serverFiles) {
      const localFile = this.app.vault.getAbstractFileByPath(path) as TFile | null;
      const localHash = localHashes.get(path);

      if (!localFile) {
        // File only on server - download
        toDownload.push({ path, serverFile });
      } else if (localHash !== serverFile.hash) {
        // Different content - use mtime to decide
        if (serverFile.mtime > localFile.stat.mtime) {
          toDownload.push({ path, serverFile });
        } else if (localFile.stat.mtime > serverFile.mtime) {
          try {
            await this.uploadFile(localFile);
            uploaded++;
          } catch (e) {
            console.error(`[VaultSync] Upload failed: ${localFile.path}`, e);
            uploadFailed++;
          }
        }
      }
    }

    // Download files with progress logging
    console.debug(`[VaultSync] Need to download ${toDownload.length} files`);

    if (toDownload.length > 0) {
      new Notice(`Downloading ${toDownload.length} files...`);
    }

    for (let i = 0; i < toDownload.length; i++) {
      const { path } = toDownload[i];

      if ((i + 1) % 10 === 0 || i === toDownload.length - 1) {
        console.debug(`[VaultSync] Downloading progress: ${i + 1}/${toDownload.length}`);
        new Notice(`Download: ${i + 1}/${toDownload.length}`);
      }

      const success = await this.downloadFile(path);
      if (success) {
        downloaded++;
      } else {
        downloadFailed++;
        console.error(`[VaultSync] Failed to download after retries: ${path}`);
        new Notice(`Failed: ${path}`);
      }

      // Small delay between downloads to avoid overwhelming mobile connections
      if (i < toDownload.length - 1) {
        await this.sleep(50);
      }
    }

    // Upload local-only files
    const toUpload = localFiles.filter(f => !serverFiles.has(f.path) && !tombstones.has(f.path));
    console.debug(`[VaultSync] Need to upload ${toUpload.length} local-only files`);

    // Debug: add upload info
    await this.app.vault.adapter.append('_sync_debug.txt', `\nTo upload: ${toUpload.length} local-only files\nLocal total: ${localFiles.length}, Server: ${serverFiles.size}\n`);

    if (toUpload.length > 0) {
      new Notice(`Uploading ${toUpload.length} files...`);
    }

    for (let i = 0; i < toUpload.length; i++) {
      const file = toUpload[i];

      if (i === 0) {
        await this.app.vault.adapter.append('_sync_debug.txt', `\nStarting upload loop at ${new Date().toISOString()}, first file: ${file.path}\n`);
      }

      if ((i + 1) % 10 === 0 || i === toUpload.length - 1) {
        console.debug(`[VaultSync] Uploading progress: ${i + 1}/${toUpload.length}`);
        await this.app.vault.adapter.append('_sync_debug.txt', `Progress: ${i + 1}/${toUpload.length}\n`);
      }

      try {
        await this.uploadFile(file);
        uploaded++;
      } catch (e: any) {
        console.error(`[VaultSync] Upload failed: ${file.path}`, e);
        uploadFailed++;
        if (i === 0) {
          await this.app.vault.adapter.append('_sync_debug.txt', `First upload failed: ${e?.message || 'Unknown error'}\n`);
        }
      }

      // Small delay between uploads
      if (i < toUpload.length - 1) {
        await this.sleep(50);
      }
    }

    // Delete files that have tombstones
    for (const path of tombstones) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        this.isProcessingRemote = true;
        try {
          await this.app.vault.delete(file);
          await this.localState.deleteFileHash(path);
          deleted++;
        } catch (e) {
          console.error(`[VaultSync] Delete failed: ${path}`, e);
        } finally {
          this.isProcessingRemote = false;
        }
      }
    }

    const summary = `Sync complete: ↓${downloaded}${downloadFailed > 0 ? '(❌' + downloadFailed + ')' : ''} ↑${uploaded}${uploadFailed > 0 ? '(❌' + uploadFailed + ')' : ''} ×${deleted}`;
    console.debug(`[VaultSync] ${summary}`);

    if (downloadFailed > 0 || uploadFailed > 0) {
      new Notice(`Vault Sync: ${summary}`);
    }
    } catch (e: any) {
      console.error('[VaultSync] processFullSync error:', e);
      new Notice(`Sync error: ${e?.message || 'Unknown error'}`);
      throw e;
    }
  }

  // Pending operations queue
  private async queuePendingOperation(type: 'upload' | 'delete', path: string): Promise<void> {
    const op: PendingOperation = {
      id: `${type}-${path}-${Date.now()}`,
      type,
      path,
      timestamp: Date.now(),
      retries: 0,
    };
    await this.localState.addPendingOperation(op);
  }

  private async processPendingOperations(): Promise<void> {
    const operations = await this.localState.getPendingOperations();
    if (operations.length === 0) return;

    for (const op of operations) {
      try {
        if (op.type === 'upload') {
          const file = this.app.vault.getAbstractFileByPath(op.path);
          if (file instanceof TFile) {
            await this.uploadFile(file);
          }
        } else if (op.type === 'delete') {
          await this.deleteFile(op.path);
        }
        await this.localState.removePendingOperation(op.id);
      } catch (e) {
        console.error(`[VaultSync] Failed to process pending op:`, op, e);
        // Keep in queue for retry
      }
    }
  }

  // Helpers
  private shouldSyncFile(path: string): boolean {
    // Skip hidden files and directories
    if (path.startsWith('.')) return false;
    if (path.includes('/.')) return false;

    // Skip specific patterns
    const excludePatterns = [
      '.git/',
      '.DS_Store',
      'Thumbs.db',
      '.tmp',
      '.temp',
      '_sync_debug',
      'PLUGIN-DEBUG',
      'SYNC-DEBUG',
      'PLUGIN-LOADED-MARKER',
    ];
    for (const pattern of excludePatterns) {
      if (path.includes(pattern)) return false;
    }

    return true;
  }

  private async computeHash(content: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', content);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Cleanup
  destroy(): void {
    // Stop file watcher
    this.fileWatcher.stop();

    // Clear pending timeouts
    for (const timeout of this.pendingChanges.values()) {
      clearTimeout(timeout);
    }
    this.pendingChanges.clear();

    this.disconnect();
    this.localState.close();
  }
}

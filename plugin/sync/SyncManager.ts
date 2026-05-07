import { App, Notice, TFile, TFolder, TAbstractFile, requestUrl } from 'obsidian';
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
    // FileWatcher needs to know which .obsidian/* paths to track (skip device-specific).
    this.fileWatcher.shouldIncludeConfigPath = (path) => this.shouldSyncFile(path);
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
    if (!this.shouldSyncFile(msg.path)) {
      await this.localState.setLastSeq(msg.seq);
      return;
    }
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
    if (!this.shouldSyncFile(msg.path)) {
      await this.localState.setLastSeq(msg.seq);
      return;
    }
    // Apply remote deletes only for paths this client has previously synced (has a hash).
    // This prevents server-side delete history from erasing files we joined to sync after the fact.
    const knownHash = await this.localState.getFileHash(msg.path);
    if (!knownHash) {
      console.debug(`[VaultSync] Ignoring remote delete for never-synced path: ${msg.path}`);
      await this.localState.setLastSeq(msg.seq);
      return;
    }
    this.isProcessingRemote = true;
    try {
      const file = this.app.vault.getAbstractFileByPath(msg.path);
      if (file instanceof TFile) {
        await this.app.vault.delete(file);
        await this.cleanupEmptyParentFolders(msg.path);
      } else if (await this.app.vault.adapter.exists(msg.path)) {
        await this.app.vault.adapter.remove(msg.path);
      }
      await this.localState.deleteFileHash(msg.path);
      await this.localState.setLastSeq(msg.seq);
      this.fileWatcher.removeFromBaseline(msg.path);
    } catch (e) {
      console.error(`[VaultSync] Failed to delete ${msg.path}:`, e);
    } finally {
      this.isProcessingRemote = false;
    }
  }

  // Clean up empty parent folders after file deletion
  private async cleanupEmptyParentFolders(filePath: string): Promise<void> {
    const parts = filePath.split('/');
    parts.pop(); // Remove filename

    while (parts.length > 0) {
      const folderPath = parts.join('/');
      const folder = this.app.vault.getAbstractFileByPath(folderPath);

      if (folder instanceof TFolder) {
        const hasFiles = folder.children.some(c => c instanceof TFile);
        const hasSubfolders = folder.children.some(c => c instanceof TFolder);

        if (!hasFiles && !hasSubfolders) {
          try {
            await this.app.vault.delete(folder);
            console.debug(`[VaultSync] Deleted empty parent folder: ${folderPath}`);
          } catch (e) {
            break; // Stop if we can't delete
          }
        } else {
          break; // Folder not empty, stop
        }
      } else {
        break;
      }

      parts.pop();
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
          } else {
            // .obsidian/* path — no TFile available, queue by path.
            this.queueUploadByPath(change.path);
          }
          break;
        case 'delete':
          // Skip delete events for .obsidian/* paths. Many plugins (iconic, dataview, etc.)
          // write their data.json atomically via temp+rename, leaving a brief window where the
          // file does not exist on disk. Without this guard FileWatcher would propagate that
          // window as a real delete to all devices, wiping configs across the cluster.
          // Real .obsidian/* deletions stay local; tombstones for them are only generated
          // when the user explicitly removes a config and the missing-state persists across
          // restarts (server-driven, not via FileWatcher).
          if (change.path.startsWith('.obsidian/')) {
            console.debug(`[VaultSync] Suppressing transient delete for .obsidian/* path: ${change.path}`);
            break;
          }
          this.queueFileDelete(change.path);
          break;
      }
    }
  }

  // Queue an upload by path with debouncing. Used for .obsidian/* paths that aren't TFile-indexed.
  queueUploadByPath(path: string): void {
    if (this.isProcessingRemote) return;
    if (!this.shouldSyncFile(path)) return;

    const existing = this.pendingChanges.get(path);
    if (existing) clearTimeout(existing);

    this.pendingChanges.set(
      path,
      setTimeout(() => {
        void this.uploadByPath(path);
        this.pendingChanges.delete(path);
      }, this.settings.debounceMs)
    );
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

  // Backwards-compat wrapper for vault-event handlers; delegates to uploadByPath which works for any path.
  private async uploadFile(file: TFile): Promise<void> {
    return this.uploadByPath(file.path);
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

        // Write file (writePathBinary uses adapter for .obsidian/* paths, vault API for indexed files).
        await this.writePathBinary(path, content);

        await this.localState.setFileHash(path, hash);

        // Update file watcher baseline so it doesn't detect this download as external change.
        // For .obsidian/* paths getAbstractFileByPath returns null (not vault-indexed) — use adapter.stat.
        const updatedFile = this.app.vault.getAbstractFileByPath(path) as TFile | null;
        if (updatedFile) {
          this.fileWatcher.markProcessed(path, updatedFile.stat.mtime, updatedFile.stat.size);
        } else {
          const stat = await this.app.vault.adapter.stat(path);
          if (stat) this.fileWatcher.markProcessed(path, stat.mtime, stat.size);
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

      // Clean up empty parent folders locally
      await this.cleanupEmptyParentFolders(path);

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

    const serverFiles = new Map(
      files.filter(f => this.shouldSyncFile(f.path)).map(f => [f.path, f])
    );
    const tombstones = new Set(
      tombstoneList.filter(t => this.shouldSyncFile(t.path)).map(t => t.path)
    );

    // Local files = vault-indexed files + .obsidian/* configs (we sync those too).
    const vaultFiles = this.app.vault.getFiles().filter(f => this.shouldSyncFile(f.path));
    const obsidianPaths = (await this.listObsidianFiles()).filter(p => this.shouldSyncFile(p));
    const localFilePaths = new Set<string>([...vaultFiles.map(f => f.path), ...obsidianPaths]);
    const localHashes = await this.localState.getAllHashes();

    console.debug(`[VaultSync] Local state: ${localFilePaths.size} files (vault: ${vaultFiles.length}, obsidian: ${obsidianPaths.length}), ${localHashes.size} hashes`);
    new Notice(`Local: ${localFilePaths.size} files`);

    // Debug: count server files not on local
    let missingCount = 0;
    const missingPaths: string[] = [];
    for (const [path] of serverFiles) {
      if (!localFilePaths.has(path)) {
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
      const localExists = localFilePaths.has(path);

      if (!localExists) {
        // File only on server — download (initial pull).
        toDownload.push({ path, serverFile });
        continue;
      }

      const action = await this.resolveSyncAction(path, serverFile, localHashes.get(path));
      if (action === 'download') {
        toDownload.push({ path, serverFile });
      } else if (action === 'upload') {
        try {
          await this.uploadByPath(path);
          uploaded++;
        } catch (e) {
          console.error(`[VaultSync] Upload failed: ${path}`, e);
          uploadFailed++;
        }
      }
      // 'noop' — local already matches server.
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

    // Upload local-only files (any path: vault or .obsidian/*)
    const toUpload = Array.from(localFilePaths).filter(p => !serverFiles.has(p) && !tombstones.has(p));
    console.debug(`[VaultSync] Need to upload ${toUpload.length} local-only files`);

    if (toUpload.length > 0) {
      new Notice(`Uploading ${toUpload.length} files...`);
    }

    for (let i = 0; i < toUpload.length; i++) {
      const path = toUpload[i];

      if ((i + 1) % 10 === 0 || i === toUpload.length - 1) {
        console.debug(`[VaultSync] Uploading progress: ${i + 1}/${toUpload.length}`);
      }

      try {
        await this.uploadByPath(path);
        uploaded++;
      } catch (e) {
        console.error(`[VaultSync] Upload failed: ${path}`, e);
        uploadFailed++;
      }

      if (i < toUpload.length - 1) {
        await this.sleep(50);
      }
    }

    // Apply tombstones — but ONLY to paths this client has previously synced (has a hash) AND
    // for which the server does NOT also have an active file record. If the server has both a
    // tombstone and a live file for the same path the file came back after deletion (e.g. a
    // plugin re-created its config after an atomic-write race) and the live record wins.
    for (const path of tombstones) {
      if (!localHashes.has(path)) {
        console.debug(`[VaultSync] Skipping tombstone for never-synced path: ${path}`);
        continue;
      }
      if (serverFiles.has(path)) {
        console.debug(`[VaultSync] Skipping stale tombstone (server has live record): ${path}`);
        continue;
      }
      this.isProcessingRemote = true;
      try {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.delete(file);
          await this.localState.deleteFileHash(path);
          deleted++;
        } else if (await this.app.vault.adapter.exists(path)) {
          await this.app.vault.adapter.remove(path);
          await this.localState.deleteFileHash(path);
          deleted++;
        }
      } catch (e) {
        console.error(`[VaultSync] Delete failed: ${path}`, e);
      } finally {
        this.isProcessingRemote = false;
      }
    }

    // Clean up empty folders
    await this.cleanupEmptyFolders();

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

  // Files inside .obsidian/ that are unique per device — never sync.
  private static readonly DEVICE_SPECIFIC_FILES = new Set<string>([
    '.obsidian/workspace.json',
    '.obsidian/workspace-mobile.json',
    '.obsidian/plugins/vault-sync/data.json',
  ]);

  // Path prefixes inside .obsidian/ that contain device-local caches and large assets — never sync.
  private static readonly DEVICE_SPECIFIC_PREFIXES = [
    '.obsidian/icons/',
    '.obsidian/file-recovery/',
    '.obsidian/cache',
  ];

  private shouldSyncFile(path: string): boolean {
    // Sync conflict files — never sync
    if (path.includes('.sync-conflict-')) return false;

    if (path.startsWith('.obsidian/')) {
      if (SyncManager.DEVICE_SPECIFIC_FILES.has(path)) return false;
      for (const prefix of SyncManager.DEVICE_SPECIFIC_PREFIXES) {
        if (path.startsWith(prefix)) return false;
      }
      return true;
    }

    // Skip other hidden files and directories
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

  // Read binary content for any path (vault-indexed or .obsidian/*).
  private async readPathBinary(path: string): Promise<{ content: ArrayBuffer; mtime: number } | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      return { content: await this.app.vault.readBinary(file), mtime: file.stat.mtime };
    }
    try {
      const content = await this.app.vault.adapter.readBinary(path);
      const stat = await this.app.vault.adapter.stat(path);
      return { content, mtime: stat?.mtime ?? Date.now() };
    } catch (e) {
      console.error(`[VaultSync] readBinary failed for ${path}:`, e);
      return null;
    }
  }

  // Write binary content for any path. Uses vault API for indexed files, adapter for .obsidian/* etc.
  private async writePathBinary(path: string, content: ArrayBuffer): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, content);
      return;
    }
    if (path.startsWith('.obsidian/')) {
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (dir && !(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.writeBinary(path, content);
      return;
    }
    const dir = path.substring(0, path.lastIndexOf('/'));
    if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
      await this.createFolderRecursively(dir);
    }
    await this.app.vault.createBinary(path, content);
  }

  /**
   * Decide whether to upload, download or do nothing for a path that exists both locally and on the server.
   *
   * Conflict resolution is hash-based, not mtime-based. We compare three hashes:
   *   - localCurrentHash: hash of the file currently on disk
   *   - lastKnownHash:    hash recorded in localState after the previous sync
   *   - serverHash:       hash from the latest sync response
   *
   * Cases:
   *   localCurrent == server                          → 'noop' (already in agreement)
   *   localCurrent == lastKnown, server != lastKnown  → 'download' (only the server changed)
   *   server == lastKnown, localCurrent != lastKnown  → 'upload'   (only we changed)
   *   both differ from lastKnown (or lastKnown unset) → real conflict; policy:
   *       .obsidian/* paths       → 'upload' (local wins; mtime on configs is unreliable
   *                                  across devices and gets reset by recovery actions)
   *       vault-indexed paths     → mtime tiebreaker (fallback)
   */
  private async resolveSyncAction(
    path: string,
    serverFile: { hash: string; mtime: number },
    lastKnownHash: string | undefined,
  ): Promise<'upload' | 'download' | 'noop'> {
    const read = await this.readPathBinary(path);
    if (!read) {
      // Local file disappeared between the listing and now — trust server.
      return 'download';
    }
    const localCurrentHash = await this.computeHash(read.content);

    if (localCurrentHash === serverFile.hash) return 'noop';
    if (lastKnownHash !== undefined) {
      if (localCurrentHash === lastKnownHash) return 'download';
      if (serverFile.hash === lastKnownHash) return 'upload';
    }
    // Real conflict (both sides advanced from the last sync, or no recorded baseline).
    if (path.startsWith('.obsidian/')) return 'upload';
    if (serverFile.mtime > read.mtime) return 'download';
    return 'upload';
  }

  // Recursively list every file under .obsidian/ via adapter API.
  private async listObsidianFiles(): Promise<string[]> {
    const result: string[] = [];
    const stack: string[] = ['.obsidian'];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      try {
        const listing = await this.app.vault.adapter.list(dir);
        for (const file of listing.files) result.push(file);
        for (const subdir of listing.folders) stack.push(subdir);
      } catch (e) {
        console.error(`[VaultSync] list failed for ${dir}:`, e);
      }
    }
    return result;
  }

  // Upload by path — works for both vault-indexed files and .obsidian/* via adapter.
  private async uploadByPath(path: string): Promise<void> {
    if (this.isProcessingRemote) return;
    if (!this.shouldSyncFile(path)) return;

    try {
      const read = await this.readPathBinary(path);
      if (!read) return;
      const { content, mtime } = read;

      const hash = await this.computeHash(content);
      const existingHash = await this.localState.getFileHash(path);
      if (existingHash === hash) return;

      if (!this.isConnected()) {
        await this.queuePendingOperation('upload', path);
        return;
      }

      const baseUrl = this.settings.serverUrl
        .replace('/ws', '')
        .replace('wss://', 'https://')
        .replace('ws://', 'http://');
      const base64Content = this.arrayBufferToBase64(content);

      const response = await requestUrl({
        url: `${baseUrl}/api/upload-json`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': this.settings.token,
          'X-Device-Id': this.settings.deviceId,
        },
        body: JSON.stringify({ path, content: base64Content, hash, mtime }),
      });

      if (response.status !== 200) {
        throw new Error(`Upload failed: ${response.status}`);
      }

      await this.localState.setFileHash(path, hash);
    } catch (e) {
      console.error(`[VaultSync] uploadByPath failed for ${path}:`, e);
      await this.queuePendingOperation('upload', path);
    }
  }

  private async computeHash(content: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', content);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Clean up empty folders recursively
  private async cleanupEmptyFolders(): Promise<void> {
    const deletedFolders: string[] = [];

    // Get all folders sorted by depth (deepest first)
    const allFolders: TFolder[] = [];
    const collectFolders = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          collectFolders(child);
          allFolders.push(child);
        }
      }
    };
    collectFolders(this.app.vault.getRoot());

    // Sort by path length descending (deepest first)
    allFolders.sort((a, b) => b.path.length - a.path.length);

    for (const folder of allFolders) {
      // Skip hidden folders
      if (folder.path.startsWith('.') || folder.path.includes('/.')) continue;

      // Check if folder is empty (no files, no subfolders)
      const hasFiles = folder.children.some(c => c instanceof TFile);
      const hasSubfolders = folder.children.some(c => c instanceof TFolder);

      if (!hasFiles && !hasSubfolders) {
        try {
          await this.app.vault.delete(folder);
          deletedFolders.push(folder.path);
          console.debug(`[VaultSync] Deleted empty folder: ${folder.path}`);
        } catch (e) {
          console.error(`[VaultSync] Failed to delete empty folder: ${folder.path}`, e);
        }
      }
    }

    if (deletedFolders.length > 0) {
      console.debug(`[VaultSync] Cleaned up ${deletedFolders.length} empty folders`);
    }
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

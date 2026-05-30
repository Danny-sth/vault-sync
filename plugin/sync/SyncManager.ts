import { App, Notice, TFile } from 'obsidian';
import { StompClient } from './StompClient';
import { FileWatcher, FileChange } from './FileWatcher';
import { LocalState } from '../storage/LocalState';
import { SyncFilter } from './SyncFilter';
import { SyncApiClient } from './SyncApiClient';
import { ConflictResolver, SyncAction } from './ConflictResolver';
import { FileOperationService } from './FileOperationService';
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
  private apiClient: SyncApiClient;
  private fileOps: FileOperationService;

  private pendingChanges: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private isProcessingRemote = false;
  private isSyncing = false;
  private connectionState: ConnectionState = 'disconnected';

  onConnectionChange?: (connected: boolean) => void;

  constructor(app: App, settings: VaultSyncSettings) {
    this.app = app;
    this.settings = settings;
    this.stompClient = new StompClient();
    this.localState = new LocalState();
    this.fileWatcher = new FileWatcher(app);
    this.apiClient = new SyncApiClient(settings);
    this.fileOps = new FileOperationService(app);

    // Set up message handlers
    this.stompClient.setMessageHandler((msg) => this.handleServerMessage(msg));
    this.stompClient.setConnectionHandler((state) => this.handleConnectionChange(state));

    // Set up file watcher handler for external FS changes
    this.fileWatcher.onChangesDetected = (changes) => this.handleFileWatcherChanges(changes);
    // FileWatcher needs to know which .obsidian/* paths to track (skip device-specific).
    this.fileWatcher.shouldIncludeConfigPath = (path) => SyncFilter.shouldSync(path);
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
    if (!SyncFilter.shouldSync(msg.path)) {
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
    if (!SyncFilter.shouldSync(msg.path)) {
      await this.localState.setLastSeq(msg.seq);
      return;
    }
    // Plugin config deletes are never propagated to this device automatically — same policy as
    // tombstones in processFullSync. Removing a config locally must be a deliberate local action.
    if (msg.path.startsWith('.obsidian/')) {
      console.debug(`[VaultSync] Ignoring remote delete for .obsidian/* path: ${msg.path}`);
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
      } else if (await this.app.vault.adapter.exists(msg.path)) {
        await this.app.vault.adapter.remove(msg.path);
      }
      // Cleanup empty parent folders after any delete
      await this.fileOps.cleanupEmptyParentFolders(msg.path);
      await this.localState.deleteFileHash(msg.path);
      await this.localState.setLastSeq(msg.seq);
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
    if (!SyncFilter.shouldSync(path)) return;

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
    if (!SyncFilter.shouldSync(file.path)) return;

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
    if (!SyncFilter.shouldSync(path)) return;

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

  private async downloadFile(path: string, retries = 3): Promise<boolean> {
    console.debug(`[VaultSync] downloadFile starting: ${path}`);
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await this.apiClient.download(path);
        if (!result) {
          throw new Error('Download returned null');
        }

        const { content, hash } = result;

        // Write file (fileOps.writeBinary uses adapter for .obsidian/* paths, vault API for indexed files).
        await this.fileOps.writeBinary(path, content);

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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async deleteFile(path: string): Promise<void> {
    try {
      if (!this.isConnected()) {
        await this.queuePendingOperation('delete', path);
        return;
      }

      await this.apiClient.delete(path);

      await this.localState.deleteFileHash(path);

      // Clean up empty parent folders locally
      await this.fileOps.cleanupEmptyParentFolders(path);

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

    // Prevent parallel sync requests (debounce rapid button clicks)
    if (this.isSyncing) {
      console.debug('[VaultSync] Sync already in progress, skipping');
      return;
    }

    this.isSyncing = true;
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
    } finally {
      this.isSyncing = false;
    }
  }

  private async processFullSync(response: SyncResponse): Promise<void> {
    try {
      const files = response.files || [];
      const tombstoneList = response.tombstones || [];

      console.debug(`[VaultSync] Full sync received: ${files.length} files, ${tombstoneList.length} tombstones, currentSeq=${response.currentSeq}`);
      new Notice(`Sync: Server has ${files.length} files`);

    const serverFiles = new Map(
      files.filter(f => SyncFilter.shouldSync(f.path)).map(f => [f.path, f])
    );
    const tombstones = new Set(
      tombstoneList.filter(t => SyncFilter.shouldSync(t.path)).map(t => t.path)
    );

    // Local files = vault-indexed files + .obsidian/* configs + hidden dirs (.trash, etc.) + hidden files in regular dirs
    const vaultFiles = this.app.vault.getFiles().filter(f => SyncFilter.shouldSync(f.path));
    const obsidianPaths = (await SyncFilter.listObsidianFiles(this.app)).filter(p => SyncFilter.shouldSync(p));
    const hiddenPaths = (await SyncFilter.listHiddenFiles(this.app)).filter(p => SyncFilter.shouldSync(p));
    const allHiddenInVault = (await SyncFilter.listAllHiddenFilesInVault(this.app)).filter(p => SyncFilter.shouldSync(p));
    const localFilePaths = new Set<string>([...vaultFiles.map(f => f.path), ...obsidianPaths, ...hiddenPaths, ...allHiddenInVault]);
    const localHashes = await this.localState.getAllHashes();

    console.debug(`[VaultSync] Local state: ${localFilePaths.size} files (vault: ${vaultFiles.length}, obsidian: ${obsidianPaths.length}, hidden: ${hiddenPaths.length}, allHidden: ${allHiddenInVault.length}), ${localHashes.size} hashes`);
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

    // FIRST: Detect locally deleted files (in localState but not on disk)
    // This catches deletions made outside Obsidian (rm, file manager, etc.)
    for (const [path] of localHashes) {
      if (!localFilePaths.has(path) && !path.startsWith('.obsidian/')) {
        // File was synced before but now doesn't exist locally → deleted locally
        console.debug(`[VaultSync] Detected local deletion: ${path}`);
        try {
          await this.deleteFile(path);
          await this.localState.deleteFileHash(path);
          deleted++;
        } catch (e) {
          console.error(`[VaultSync] Failed to sync local deletion: ${path}`, e);
        }
      }
    }

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

    // Apply tombstones to vault-indexed paths only.
    //
    // Rationale: .obsidian/* tombstones are never replayed automatically. Plugin configs are
    // critical, easy to lose, and trivial to re-create locally if the user actually wants them
    // gone — but server-side stale tombstones (residual from earlier bugs, atomic-write races,
    // or fresh installs uploading empty defaults) propagated to every device cause cluster-wide
    // config loss with high recovery cost. Vault notes on the other hand are handled the standard
    // way (a real deletion on one device should reach others).
    //
    // For vault paths we still gate on (a) prior sync history, and (b) absence of a live server
    // record for the same path.
    for (const path of tombstones) {
      if (path.startsWith('.obsidian/')) {
        console.debug(`[VaultSync] Tombstones never auto-apply to .obsidian/* paths: ${path}`);
        continue;
      }
      const lastKnownHash = localHashes.get(path);
      if (!lastKnownHash) {
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
        // If we deleted a .folder-marker, also delete the parent folder if it's now empty
        // This prevents syncEmptyFolderMarkers from re-creating the marker
        if (path.endsWith('.folder-marker')) {
          const parentPath = path.substring(0, path.lastIndexOf('/'));
          if (parentPath) {
            await this.fileOps.cleanupEmptyParentFolders(path);
          }
        }
      } catch (e) {
        console.error(`[VaultSync] Delete failed: ${path}`, e);
      } finally {
        this.isProcessingRemote = false;
      }
    }

    // Sync empty folder markers - create markers for empty folders, upload them
    // Pass tombstones to avoid re-creating markers for folders that server deleted
    const markers = await SyncFilter.syncEmptyFolderMarkers(this.app, tombstones);
    for (const markerPath of markers.created) {
      try {
        await this.uploadByPath(markerPath);
        uploaded++;
      } catch (e) {
        console.error(`[VaultSync] Failed to upload folder marker: ${markerPath}`, e);
      }
    }
    for (const markerPath of markers.deleted) {
      try {
        await this.deleteFile(markerPath);
        deleted++;
      } catch (e) {
        console.error(`[VaultSync] Failed to delete folder marker: ${markerPath}`, e);
      }
    }

    // Clean up empty folders (but not folders with .folder-marker)
    await this.fileOps.cleanupEmptyFolders();

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

  /**
   * Decide whether to upload, download or do nothing for a path that exists both locally and on the server.
   * Delegates conflict resolution logic to ConflictResolver.
   */
  private async resolveSyncAction(
    path: string,
    serverFile: { hash: string; mtime: number },
    lastKnownHash: string | undefined,
  ): Promise<SyncAction> {
    const read = await this.fileOps.readBinary(path);
    if (!read) {
      return 'download';
    }

    const localHash = await this.computeHash(read.content);

    return ConflictResolver.resolve(
      path,
      { hash: localHash, mtime: read.mtime },
      { hash: serverFile.hash, mtime: serverFile.mtime },
      lastKnownHash
    );
  }

  // Upload by path — works for both vault-indexed files and .obsidian/* via adapter.
  private async uploadByPath(path: string): Promise<void> {
    if (this.isProcessingRemote) return;
    if (!SyncFilter.shouldSync(path)) return;

    try {
      const read = await this.fileOps.readBinary(path);
      if (!read) return;
      const { content, mtime } = read;

      const hash = await this.computeHash(content);
      const existingHash = await this.localState.getFileHash(path);
      if (existingHash === hash) return;

      if (!this.isConnected()) {
        await this.queuePendingOperation('upload', path);
        return;
      }

      await this.apiClient.upload(path, content, hash, mtime);

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

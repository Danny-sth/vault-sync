import { App, Notice, TFile } from 'obsidian';
import { StompClient } from './StompClient';
import { FileWatcher, FileChange } from './FileWatcher';
import { LocalState } from '../storage/LocalState';
import { SyncFilter } from './SyncFilter';
import { SyncApiClient, ConflictError } from './SyncApiClient';
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

    this.stompClient.setMessageHandler((msg) => this.handleServerMessage(msg));
    this.stompClient.setConnectionHandler((state) => this.handleConnectionChange(state));

    this.fileWatcher.onChangesDetected = (changes) => this.handleFileWatcherChanges(changes);
    this.fileWatcher.shouldIncludeConfigPath = (path) => SyncFilter.shouldSync(path);
  }

  async init(): Promise<void> {
    await this.localState.init();
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
    if (msg.path.startsWith('.obsidian/') && !msg.path.startsWith('.obsidian/plugins/')) {
      console.debug(`[VaultSync] Ignoring remote delete for .obsidian/* path (not plugins): ${msg.path}`);
      await this.localState.setLastSeq(msg.seq);
      return;
    }
    const knownHash = await this.localState.getFileHash(msg.path);
    const isPlugin = msg.path.startsWith('.obsidian/plugins/');
    if (!knownHash && !isPlugin) {
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
            this.queueUploadByPath(change.path);
          }
          break;
        case 'delete':
          if (change.path.startsWith('.obsidian/') && !change.path.startsWith('.obsidian/plugins/')) {
            console.debug(`[VaultSync] Suppressing transient delete for .obsidian/* path (not plugins): ${change.path}`);
            break;
          }
          this.queueFileDelete(change.path);
          break;
      }
    }
  }

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

    this.queueFileDelete(oldPath);
    this.queueFileChange(file);
  }

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

        await this.fileOps.writeBinary(path, content);

        await this.localState.setFileHash(path, hash);

        const updatedFile = this.app.vault.getAbstractFileByPath(path) as TFile | null;
        if (updatedFile) {
          this.fileWatcher.markProcessed(path, updatedFile.stat.mtime, updatedFile.stat.size);
        } else {
          const stat = await this.app.vault.adapter.stat(path);
          if (stat) this.fileWatcher.markProcessed(path, stat.mtime, stat.size);
        }

        return true;

      } catch (e: any) {
        console.error(`[VaultSync] Download attempt ${attempt}/${retries} failed for ${path}:`, e);
        if (attempt < retries) {
          await this.sleep(1000 * attempt);
        }
      }
    }
    return false;
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

      await this.fileOps.cleanupEmptyParentFolders(path);

    } catch (e) {
      console.error(`[VaultSync] Delete failed for ${path}:`, e);
      await this.queuePendingOperation('delete', path);
    }
  }

  async requestFullSync(): Promise<void> {
    if (!this.isConnected()) {
      new Notice('Vault Sync: Not connected');
      return;
    }

    if (this.isSyncing) {
      console.debug('[VaultSync] Sync already in progress, skipping');
      return;
    }

    this.isSyncing = true;
    try {
      new Notice('Vault Sync: Syncing...');
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

    const vaultFiles = this.app.vault.getFiles().filter(f => SyncFilter.shouldSync(f.path));
    const obsidianPaths = (await SyncFilter.listObsidianFiles(this.app)).filter(p => SyncFilter.shouldSync(p));
    const hiddenPaths = (await SyncFilter.listHiddenFiles(this.app)).filter(p => SyncFilter.shouldSync(p));
    const allHiddenInVault = (await SyncFilter.listAllHiddenFilesInVault(this.app)).filter(p => SyncFilter.shouldSync(p));
    const localFilePaths = new Set<string>([...vaultFiles.map(f => f.path), ...obsidianPaths, ...hiddenPaths, ...allHiddenInVault]);
    const localHashes = await this.localState.getAllHashes();

    console.log(`[VaultSync] ========== FULL SYNC START ==========`);
    console.log(`[VaultSync] Server: ${serverFiles.size} files, ${tombstones.size} tombstones`);
    console.log(`[VaultSync] Local: ${localFilePaths.size} files (vault: ${vaultFiles.length}, obsidian: ${obsidianPaths.length}, hidden: ${hiddenPaths.length}, allHidden: ${allHiddenInVault.length})`);
    console.log(`[VaultSync] LocalState: ${localHashes.size} stored hashes`);
    new Notice(`Sync: Server=${serverFiles.size}, Local=${localFilePaths.size}, Tombstones=${tombstones.size}`);

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

    for (const [path] of localHashes) {
      const isProtectedObsidian = path.startsWith('.obsidian/') && !path.startsWith('.obsidian/plugins/');
      if (!localFilePaths.has(path) && !isProtectedObsidian) {
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

    const toDownload: { path: string; serverFile: { hash: string; mtime: number } }[] = [];

    for (const [path, serverFile] of serverFiles) {
      const localExists = localFilePaths.has(path);

      if (!localExists) {
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
    }

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

      if (i < toDownload.length - 1) {
        await this.sleep(50);
      }
    }

    const tombstonedToDelete: string[] = [];
    for (const path of tombstones) {
      if (localFilePaths.has(path)) {
        console.log(`[VaultSync] TOMBSTONE found for local file, will delete: ${path}`);
        tombstonedToDelete.push(path);
      } else {
        console.debug(`[VaultSync] TOMBSTONE exists but file not local: ${path}`);
      }
    }

    const toUpload: string[] = [];
    const toDeleteLocallyOld: string[] = [];

    for (const path of localFilePaths) {
      if (serverFiles.has(path)) {
        console.debug(`[VaultSync] File exists on server, skip upload: ${path}`);
        continue;
      }

      if (tombstones.has(path)) {
        console.debug(`[VaultSync] File has tombstone, already in tombstonedToDelete: ${path}`);
        continue;
      }

      const lastKnownHash = localHashes.get(path);

      if (lastKnownHash) {
        console.log(`[VaultSync] File was synced but deleted on server (lastKnownHash=${lastKnownHash.substring(0, 8)}...), will delete locally: ${path}`);
        toDeleteLocallyOld.push(path);
      } else {
        console.log(`[VaultSync] New local file (no lastKnownHash), will upload: ${path}`);
        toUpload.push(path);
      }
    }

    console.log(`[VaultSync] SYNC PLAN: Upload=${toUpload.length}, Delete(old)=${toDeleteLocallyOld.length}, Delete(tombstone)=${tombstonedToDelete.length}`);

    if (tombstonedToDelete.length > 0) {
      new Notice(`Removing ${tombstonedToDelete.length} tombstoned files...`);
    }

    for (const path of tombstonedToDelete) {
      this.isProcessingRemote = true;
      try {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.delete(file);
        } else if (await this.app.vault.adapter.exists(path)) {
          await this.app.vault.adapter.remove(path);
        }
        await this.localState.deleteFileHash(path);
        await this.fileOps.cleanupEmptyParentFolders(path);
        deleted++;
        console.log(`[VaultSync] Deleted tombstoned file: ${path}`);
      } catch (e) {
        console.error(`[VaultSync] Failed to delete tombstoned file: ${path}`, e);
      } finally {
        this.isProcessingRemote = false;
      }
    }

    if (toDeleteLocallyOld.length > 0) {
      new Notice(`Removing ${toDeleteLocallyOld.length} files deleted on server...`);
    }

    for (const path of toDeleteLocallyOld) {
      this.isProcessingRemote = true;
      try {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.delete(file);
        } else if (await this.app.vault.adapter.exists(path)) {
          await this.app.vault.adapter.remove(path);
        }
        await this.localState.deleteFileHash(path);
        await this.fileOps.cleanupEmptyParentFolders(path);
        deleted++;
        console.log(`[VaultSync] Deleted old file: ${path}`);
      } catch (e) {
        console.error(`[VaultSync] Failed to delete old file: ${path}`, e);
      } finally {
        this.isProcessingRemote = false;
      }
    }

    if (toUpload.length > 0) {
      new Notice(`Uploading ${toUpload.length} new files...`);
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

    for (const path of tombstones) {
      if (path.startsWith('.obsidian/') && !path.startsWith('.obsidian/plugins/')) {
        console.debug(`[VaultSync] Tombstones never auto-apply to .obsidian/* paths (except plugins): ${path}`);
        continue;
      }
      const lastKnownHash = localHashes.get(path);
      const isPlugin = path.startsWith('.obsidian/plugins/');
      if (!lastKnownHash && !isPlugin) {
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

    await this.fileOps.cleanupEmptyFolders();

    const summary = `Sync complete: ↓${downloaded}${downloadFailed > 0 ? '(❌' + downloadFailed + ')' : ''} ↑${uploaded}${uploadFailed > 0 ? '(❌' + uploadFailed + ')' : ''} ×${deleted}`;
    console.log(`[VaultSync] ========== FULL SYNC END ==========`);
    console.log(`[VaultSync] ${summary}`);
    console.log(`[VaultSync] Downloaded: ${downloaded}, Uploaded: ${uploaded}, Deleted: ${deleted}`);
    console.log(`[VaultSync] Failures: download=${downloadFailed}, upload=${uploadFailed}`);

    if (downloadFailed > 0 || uploadFailed > 0) {
      new Notice(`Vault Sync: ${summary}`);
    }
    } catch (e: any) {
      console.error('[VaultSync] processFullSync error:', e);
      new Notice(`Sync error: ${e?.message || 'Unknown error'}`);
      throw e;
    }
  }

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

  private async uploadByPath(path: string): Promise<void> {
    if (this.isProcessingRemote) return;
    if (!SyncFilter.shouldSync(path)) return;

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

    try {
      await this.apiClient.upload(path, content, hash, mtime, existingHash ?? '');
      await this.localState.setFileHash(path, hash);
    } catch (e) {
      if (e instanceof ConflictError) {
        await this.reconcileConflict(path, content, e.deleted);
        return;
      }
      console.error(`[VaultSync] uploadByPath failed for ${path}:`, e);
      await this.queuePendingOperation('upload', path);
    }
  }

  /**
   * The server rejected our upload (HTTP 409) because it holds a newer version and we
   * were editing a stale base. Adopt the server version (agreed source of truth) and
   * preserve our rejected local content as a side "conflict" copy so nothing is lost.
   * This is what stops a stale/desynced device from clobbering newer notes.
   */
  private async reconcileConflict(path: string, localContent: ArrayBuffer, deleted = false): Promise<void> {
    // Server deleted this path elsewhere (live tombstone) — honor the deletion locally
    // instead of resurrecting it. This stops the "deleted folders keep coming back" loop.
    if (deleted) {
      console.warn(`[VaultSync] ${path} was deleted on server — removing local copy (no resurrection)`);
      this.isProcessingRemote = true;
      try {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.delete(file);
        } else if (await this.app.vault.adapter.exists(path)) {
          await this.app.vault.adapter.remove(path);
        }
        await this.localState.deleteFileHash(path);
        await this.fileOps.cleanupEmptyParentFolders(path);
        this.fileWatcher.removeFromBaseline(path);
      } catch (e) {
        console.error(`[VaultSync] Failed to honor remote deletion of ${path}:`, e);
      } finally {
        this.isProcessingRemote = false;
      }
      return;
    }

    console.warn(`[VaultSync] Upload conflict for ${path} — adopting server version, preserving local copy`);

    this.isProcessingRemote = true;
    try {
      await this.downloadFile(path);
    } finally {
      this.isProcessingRemote = false;
    }

    const serverContent = await this.fileOps.readBinary(path);
    const sameAsServer = serverContent
      && (await this.computeHash(serverContent.content)) === (await this.computeHash(localContent));

    if (localContent.byteLength > 0 && !sameAsServer) {
      const dot = path.lastIndexOf('.');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const suffix = ` (conflict ${this.settings.deviceId} ${stamp})`;
      const conflictPath = dot > 0 ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`;
      await this.fileOps.writeBinary(conflictPath, localContent);
      new Notice(`Vault Sync: conflict on ${path.split('/').pop()} — took server version, saved your copy`);
    }
  }

  private async computeHash(content: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', content);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  destroy(): void {
    this.fileWatcher.stop();

    for (const timeout of this.pendingChanges.values()) {
      clearTimeout(timeout);
    }
    this.pendingChanges.clear();

    this.disconnect();
    this.localState.close();
  }
}

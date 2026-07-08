import { App, Notice, TFile } from 'obsidian';
import { StompClient } from './StompClient';
import { FileWatcher, FileChange } from './FileWatcher';
import { LocalState } from '../storage/LocalState';
import { SyncFilter } from './SyncFilter';
import { SyncApiClient, ConflictError } from './SyncApiClient';
import { ConflictResolver, SyncAction } from './ConflictResolver';
import { FileOperationService } from './FileOperationService';
import { SyncStatusNotice } from './SyncStatusNotice';
import { tombstoneApplies as decideTombstone } from './TombstoneLogic';
import { VaultCipher } from '../crypto/VaultCipher';
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
  private readonly status = new SyncStatusNotice();
  /** Session cipher when E2EE is enabled; null = plaintext sync (legacy). */
  private cipher: VaultCipher | null = null;

  // Paths whose server bytes are NOT a VSE blob (plaintext written by a non-encrypting
  // server-side process, e.g. a legacy server-side writer). They can't be decrypted
  // with the vault key, so we skip them once instead of failing+retrying every sync. They
  // simply don't appear on this device until that writer encrypts them.
  private readonly undecryptable = new Set<string>();

  private pendingChanges: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /**
   * Paths this manager is CURRENTLY writing/deleting because of a remote event. Local
   * change events for exactly these paths are echoes of our own writes and are ignored;
   * everything else keeps flowing. (The old single boolean flag silently dropped ALL
   * concurrent local edits whenever any remote download was in flight.)
   */
  private readonly remoteWrites = new Set<string>();
  private isSyncing = false;
  private connectionState: ConnectionState = 'disconnected';
  /**
   * Lowest server seq whose download failed this session. lastSeq must never advance
   * past it — otherwise the failed file falls out of every future delta and this device
   * keeps a stale copy until a manual full sync. null = no outstanding failure.
   */
  private lowestFailedSeq: number | null = null;

  onConnectionChange?: (connected: boolean) => void;
  /** Fired after a mergeable config map (icon assignments) is written by sync,
   *  so in-memory consumers (FileIcons) can reload without an app restart. */
  onConfigMapDownloaded?: (path: string) => void;

  constructor(app: App, settings: VaultSyncSettings) {
    this.app = app;
    this.settings = settings;
    this.stompClient = new StompClient({
      reconnectDelayMs: settings.reconnectDelayMs,
      heartbeatIntervalMs: settings.heartbeatIntervalMs,
      syncTimeoutMs: settings.syncTimeoutMs,
    });
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
    await this.initCipher();
    this.fileWatcher.start(10000);
  }

  /**
   * Build the session cipher from settings when E2EE is enabled. PBKDF2 derivation
   * is async; the key is derived exactly once here. A misconfigured (missing
   * passphrase/salt) encrypted setup is left as null and surfaced, rather than
   * silently syncing plaintext.
   */
  private async initCipher(): Promise<void> {
    if (!this.settings.encryptionEnabled) {
      this.cipher = null;
      return;
    }
    if (!this.settings.encryptionPassphrase || !this.settings.encryptionSaltB64) {
      this.cipher = null;
      console.error('[VaultSync] Encryption enabled but passphrase/salt missing — refusing to sync');
      this.status.error('шифрование: нет ключа/соли');
      return;
    }
    // Salt is user-editable: a non-base64 value makes atob throw and would otherwise
    // crash plugin init. Fail closed (cipher stays null → I/O aborts, no plaintext leak).
    try {
      const salt = Uint8Array.from(atob(this.settings.encryptionSaltB64), (c) => c.charCodeAt(0));
      this.cipher = await VaultCipher.fromPassphrase(this.settings.encryptionPassphrase, salt);
      console.debug('[VaultSync] E2EE enabled — content encrypted client-side');
    } catch (e) {
      this.cipher = null;
      console.error('[VaultSync] E2EE init failed (bad salt?):', e);
      this.status.error('шифрование: некорректная соль');
    }
  }

  /**
   * Fail closed: if E2EE is enabled but the cipher could not be built (missing or bad
   * passphrase/salt), abort all content I/O instead of silently falling back to
   * plaintext upload / writing an undecrypted blob into the vault. Better a loud,
   * recoverable failure than leaking the user's notes in the clear.
   */
  private assertCipherConsistent(): void {
    if (this.settings.encryptionEnabled && !this.cipher) {
      throw new Error('VaultSync: E2EE enabled but cipher not initialised (passphrase/salt?) — refusing plaintext I/O');
    }
  }

  /**
   * Hash used for all server-facing comparisons (dedup, conflict, baseHash). When
   * encrypted this is SHA-256 of the blob the server stores; otherwise SHA-256 of
   * the plaintext. Keeping a single source means the plugin and server never end up
   * in different hash spaces.
   */
  private async serverHash(path: string, content: ArrayBuffer): Promise<string> {
    this.assertCipherConsistent();
    return this.cipher ? this.cipher.blobHashHex(path, content) : this.computeHash(content);
  }

  /** Real vault path → the (encrypted) path the server stores it under. */
  private toServerPath(realPath: string): string {
    return this.cipher ? this.cipher.encryptPath(realPath) : realPath;
  }

  /** Encrypted server path → real vault path. Returns null if it can't be decrypted
   *  (a plaintext path from a non-encrypting writer) so the caller can skip it. */
  private toRealPath(serverPath: string): string | null {
    if (!this.cipher) return serverPath;
    try {
      return this.cipher.decryptPath(serverPath);
    } catch {
      return null;
    }
  }

  /** Plaintext → bytes to upload (ciphertext blob when encrypted, else as-is). */
  private encodeForUpload(path: string, content: ArrayBuffer): ArrayBuffer {
    this.assertCipherConsistent();
    return this.cipher ? this.cipher.encryptToArrayBuffer(path, content) : content;
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
      // Catch-up (incremental sync + pending ops) runs from handleConnectionChange,
      // which also covers silent stompjs auto-reconnects — one recovery path.
    } catch (e) {
      console.error('[VaultSync] Connection failed:', e);
      this.status.error('нет связи с сервером');
    }
  }

  disconnect(): void {
    this.stompClient.disconnect();
  }

  isConnected(): boolean {
    return this.stompClient.isConnected();
  }

  /** True after destroy(): every late async callback (zombie STOMP client from a
   *  plugin reload, in-flight timer) must become a no-op — the IndexedDB is closed. */
  private destroyed = false;

  private handleConnectionChange(state: ConnectionState): void {
    if (this.destroyed) return;
    const wasConnected = this.connectionState === 'connected';
    this.connectionState = state;

    if (state === 'connected') {
      console.debug('[VaultSync] Connected');
      this.onConnectionChange?.(true);
      // Catch up on everything missed while offline — this fires on the FIRST connect
      // and on every silent stompjs auto-reconnect. Without it, broadcasts dropped
      // during an outage were simply never applied until an app restart.
      if (!wasConnected) {
        void this.requestIncrementalSync()
          .then(() => this.processPendingOperations())
          .catch((e) => console.error('[VaultSync] Post-connect catch-up failed:', e));
      }
    } else if (state === 'disconnected') {
      this.onConnectionChange?.(false);
    }
  }

  /** Mark a path as being written by remote processing (suppresses our own echo). */
  private beginRemote(path: string): void {
    this.remoteWrites.add(path);
  }

  private endRemote(path: string): void {
    this.remoteWrites.delete(path);
  }

  /** Record a failed download's seq so lastSeq can't advance past it. */
  private noteFailedSeq(seq: number | undefined): void {
    if (typeof seq !== 'number' || seq <= 0) return;
    if (this.lowestFailedSeq === null || seq < this.lowestFailedSeq) {
      this.lowestFailedSeq = seq;
    }
  }

  /**
   * Advance the persisted lastSeq, clamped below any failed download's seq so the
   * next incremental sync re-delivers (and retries) the failed file.
   */
  private async advanceLastSeq(seq: number): Promise<void> {
    const capped = this.lowestFailedSeq !== null ? Math.min(seq, this.lowestFailedSeq - 1) : seq;
    await this.localState.setLastSeq(capped);
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
    // Server paths are encrypted; decrypt to the real vault path. A path that won't
    // decrypt is from a non-encrypting writer (duq plaintext) — record seq and skip.
    const path = this.toRealPath(msg.path);
    if (path === null || !SyncFilter.shouldSync(path)) {
      await this.advanceLastSeq(msg.seq);
      return;
    }
    // The content changed on the server — clear any prior "can't decrypt" mark so a now
    // properly-encrypted version (e.g. duq switching to put_blob) is fetched and decrypted.
    this.undecryptable.delete(path);
    this.beginRemote(path);
    try {
      const success = await this.downloadFile(path);
      if (success) {
        await this.localState.setFileSeq(path, msg.seq);
      } else {
        console.error(`[VaultSync] Remote file change failed to download: ${path}`);
        this.noteFailedSeq(msg.seq);
      }
      await this.advanceLastSeq(msg.seq);
    } finally {
      this.endRemote(path);
    }
  }

  private async handleRemoteFileDelete(msg: FileDeletedMessage): Promise<void> {
    const path = this.toRealPath(msg.path);
    if (path === null || !SyncFilter.shouldSync(path)) {
      await this.advanceLastSeq(msg.seq);
      return;
    }
    if (path.startsWith('.obsidian/') && !path.startsWith('.obsidian/plugins/')) {
      console.debug(`[VaultSync] Ignoring remote delete for .obsidian/* path (not plugins): ${path}`);
      await this.advanceLastSeq(msg.seq);
      return;
    }
    const knownHash = await this.localState.getFileHash(path);
    const isPlugin = path.startsWith('.obsidian/plugins/');
    if (!knownHash && !isPlugin) {
      console.debug(`[VaultSync] Ignoring remote delete for never-synced path: ${path}`);
      await this.advanceLastSeq(msg.seq);
      return;
    }
    this.beginRemote(path);
    try {
      await this.applyRemoteDelete(path);
      await this.advanceLastSeq(msg.seq);
      // Remember the DELETE's seq (survives deletion) so a later re-create can
      // prove this device knew about the deletion → genuine recreation.
      await this.localState.setFileSeq(path, msg.seq);
    } catch (e) {
      console.error(`[VaultSync] Failed to delete ${path}:`, e);
    } finally {
      this.endRemote(path);
    }
  }

  /**
   * Delete a local file because the server says it was deleted — but never throw away
   * an UNSYNCED local edit with it: if the current content differs from the last hash
   * this device synced, the edit is preserved as a "(conflict …)" side copy first.
   * (Scenario this guards: device A edits offline, device B deletes the file, A comes
   * online — the tombstone used to silently destroy A's edit.)
   */
  private async applyRemoteDelete(path: string): Promise<boolean> {
    try {
      const lastKnown = await this.localState.getFileHash(path);
      if (lastKnown && !path.startsWith('.obsidian/')) {
        const read = await this.fileOps.readBinary(path);
        if (read && read.content.byteLength > 0) {
          const currentHash = await this.serverHash(path, read.content);
          if (currentHash !== lastKnown) {
            await this.saveConflictCopy(path, read.content);
          }
        }
      }
    } catch (e) {
      console.error(`[VaultSync] Edit-guard check failed for ${path}:`, e);
    }
    const removed = await this.fileOps.deleteIfPresent(path);
    await this.fileOps.cleanupEmptyParentFolders(path);
    await this.localState.deleteFileHash(path);
    this.fileWatcher.removeFromBaseline(path);
    return removed;
  }

  private handleFileWatcherChanges(changes: FileChange[]): void {
    // Per-path suppression: only our own in-flight remote writes are echoes; a change
    // to any OTHER path is a real local edit and must not be dropped.
    changes = changes.filter((c) => !this.remoteWrites.has(c.path));
    if (changes.length === 0) return;

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
    if (this.remoteWrites.has(path)) return;
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
    if (this.remoteWrites.has(file.path)) return;
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
    if (this.remoteWrites.has(path)) return;
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
    // Per-path suppression happens inside the two queue calls.
    this.queueFileDelete(oldPath);
    this.queueFileChange(file);
  }

  private async uploadFile(file: TFile): Promise<void> {
    return this.uploadByPath(file.path);
  }

  private async downloadFile(path: string, retries = this.settings.retryAttempts): Promise<boolean> {
    // Known-plaintext (undecryptable) file from a non-encrypting writer — don't re-fetch.
    if (this.undecryptable.has(path)) return true;
    console.debug(`[VaultSync] downloadFile starting: ${path}`);
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await this.apiClient.download(this.toServerPath(path));
        if (result === null) {
          // Server returned 404 — the file was already deleted upstream (a benign race,
          // typically from a rapidly create+deleted file). Don't retry, don't log an error:
          // the matching file_deleted broadcast will remove any local copy. This is the fix
          // for the Android "Failed to download after retries" error storm.
          console.debug(`[VaultSync] ${path} gone upstream (404) — skipping download`);
          return true;
        }

        const { content, hash } = result;

        // Fail closed when E2EE is enabled but the cipher is missing — never write a
        // raw ciphertext blob into the vault as if it were plaintext.
        this.assertCipherConsistent();

        // Server delivers the ciphertext blob; decrypt to plaintext before writing
        // into the vault. A decrypt failure (corrupt blob / wrong key / a legacy
        // plaintext file mid-migration) must NOT clobber the local file with garbage.
        let toWrite = content;
        if (this.cipher) {
          try {
            toWrite = this.cipher.decryptToArrayBuffer(path, content);
          } catch (e) {
            if (VaultCipher.isEncryptedBlob(content)) {
              // A REAL VSE blob that fails its GCM tag = wrong key or corruption. This
              // must be loud: silently skipping made a device with a typo'd passphrase
              // look "fully synced" while its vault quietly diverged.
              this.reportKeyMismatch(path);
              return false;
            }
            // No VSE header → plaintext from a non-encrypting writer. Benign: skip once
            // (no retry, not a failure) so it doesn't spam the sync with errors.
            this.undecryptable.add(path);
            console.debug(`[VaultSync] Skipping undecryptable (plaintext) file: ${path}`);
            return true;
          }
        }

        // Check existence first: readBinary on a missing file logs a noisy error on mobile.
        const localExists = await this.app.vault.adapter.exists(path);
        const existing = localExists ? await this.fileOps.readBinary(path) : null;

        // Mergeable config maps (icon assignments) are shared key→value JSON edited from
        // multiple devices. A plain last-write-wins overwrite drops the other device's keys
        // (this is what wiped folder-icons.json down to one entry). Instead UNION the maps:
        // keep every key, server wins on a same-key conflict. If our local copy had keys the
        // server lacks, push the union back so the server converges. This strictly grows the
        // key set each round → converges, no loop, and never loses an entry.
        if (SyncManager.MERGEABLE_JSON_MAPS.has(path) && existing && existing.content.byteLength > 0) {
          const merged = this.mergeJsonMap(existing.content, toWrite);
          // Only deviate from a plain server-write when our local copy has keys the server
          // lacks. Then the union differs from the server, so we write it AND push it up.
          // Otherwise (local is a subset, or only same-key conflicts) the server version IS
          // the union — write it as-is below so local matches the server byte-for-byte; a
          // re-serialized-but-equal merge would never hash-match the server and would loop.
          if (merged && merged.hasLocalExtra) {
            await this.fileOps.writeBinary(path, merged.content);
            const mergedHash = await this.serverHash(path, merged.content);
            await this.localState.setFileHash(path, mergedHash);
            await this.markDownloadedProcessed(path);
            await this.uploadMergedDirect(path, merged.content, mergedHash, hash);
            this.onConfigMapDownloaded?.(path);
            return true;
          }
        }

        // Conflict guard for EVERY download path (full-sync AND real-time broadcast):
        // if the local file has an unsynced edit (its hash differs from the last synced
        // hash and from what we're about to write), preserve it as a side copy before
        // overwriting — otherwise an offline/concurrent edit is silently lost. This
        // includes lastKnown === undefined: a NEVER-synced local file (both devices
        // created "Meeting.md" independently) is by definition unsynced content, and
        // requiring lastKnown here silently discarded the local version. .obsidian/*
        // is exempt — config/plugin files are machine-generated, conflict copies there
        // would be pure noise (icon maps are union-merged above instead).
        if (existing && existing.content.byteLength > 0 && !path.startsWith('.obsidian/')) {
          const lastKnown = await this.localState.getFileHash(path);
          const existingHash = await this.serverHash(path, existing.content);
          if (existingHash !== hash && existingHash !== lastKnown) {
            await this.saveConflictCopy(path, existing.content);
          }
        }

        await this.fileOps.writeBinary(path, toWrite);

        // Store the server's blob hash (== serverHash space) so later change
        // detection compares like-for-like and doesn't re-upload unchanged files.
        await this.localState.setFileHash(path, hash);

        await this.markDownloadedProcessed(path);

        if (SyncManager.MERGEABLE_JSON_MAPS.has(path)) this.onConfigMapDownloaded?.(path);

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

  /** True after the wrong-key banner was shown, so it fires once per session, not per file. */
  private keyMismatchReported = false;

  /** Loud, once-per-session alarm for "server blob exists but our key can't open it". */
  private reportKeyMismatch(path: string): void {
    console.error(`[VaultSync] DECRYPT FAILED for a real VSE blob: ${path} — wrong passphrase/salt?`);
    if (this.keyMismatchReported) return;
    this.keyMismatchReported = true;
    this.status.error('E2EE: ключ не подходит к данным сервера');
    new Notice('Vault Sync: НЕ УДАЛОСЬ РАСШИФРОВАТЬ данные сервера — проверь passphrase/salt. Синк этих файлов остановлен.', 15000);
  }

  /**
   * Shared key→value JSON config maps that must be UNION-merged on download instead of
   * overwritten, so a concurrent edit from another device never drops the other's keys.
   */
  private static readonly MERGEABLE_JSON_MAPS = new Set<string>([
    '.obsidian/folder-icons.json',
    '.obsidian/file-icons.json',
  ]);

  /** Re-sync the FileWatcher baseline for a freshly-written path so it isn't re-detected. */
  private async markDownloadedProcessed(path: string): Promise<void> {
    const updatedFile = this.app.vault.getAbstractFileByPath(path) as TFile | null;
    if (updatedFile) {
      this.fileWatcher.markProcessed(path, updatedFile.stat.mtime, updatedFile.stat.size);
    } else {
      const stat = await this.app.vault.adapter.stat(path);
      if (stat) this.fileWatcher.markProcessed(path, stat.mtime, stat.size);
    }
  }

  /**
   * Union two JSON object maps. Every key from both sides is kept; on a same-key conflict the
   * server (incoming) value wins. Returns the merged buffer plus whether the local copy had
   * keys the server lacked (→ the union differs from the server and must be pushed back).
   * Returns null when either side isn't a plain JSON object (caller falls back to overwrite).
   */
  private mergeJsonMap(localBuf: ArrayBuffer, serverBuf: ArrayBuffer): { content: ArrayBuffer; hasLocalExtra: boolean } | null {
    try {
      const local = JSON.parse(new TextDecoder().decode(localBuf));
      const server = JSON.parse(new TextDecoder().decode(serverBuf));
      if (!local || !server || typeof local !== 'object' || typeof server !== 'object'
        || Array.isArray(local) || Array.isArray(server)) return null;
      const merged: Record<string, unknown> = { ...local, ...server };
      let hasLocalExtra = false;
      for (const k of Object.keys(local)) {
        if (!(k in server)) { hasLocalExtra = true; break; }
      }
      const json = JSON.stringify(merged, null, 2);
      const u8 = new TextEncoder().encode(json);
      const content = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      return { content, hasLocalExtra };
    } catch {
      return null;
    }
  }

  /**
   * Push a merged config map back to the server (optimistic-concurrency against the version
   * we just downloaded). On a 409 the server moved again — we don't retry here; the next
   * download merges afresh and the union still converges.
   */
  private async uploadMergedDirect(path: string, content: ArrayBuffer, hash: string, baseHash: string): Promise<void> {
    try {
      const baseSeq = await this.localState.getFileSeq(path);
      const payload = this.encodeForUpload(path, content);
      const seq = await this.apiClient.upload(this.toServerPath(path), payload, hash, Date.now(), baseHash, baseSeq);
      await this.localState.setFileHash(path, hash);
      await this.localState.setFileSeq(path, seq);
      console.debug(`[VaultSync] Merged ${path}: kept local-only keys, pushed union to server`);
    } catch (e) {
      if (e instanceof ConflictError) {
        console.debug(`[VaultSync] Merge upload conflict for ${path} — reconciles on next sync`);
        return;
      }
      console.error(`[VaultSync] Merge upload failed for ${path}:`, e);
    }
  }

  private async deleteFile(path: string): Promise<void> {
    try {
      if (!this.isConnected()) {
        await this.queuePendingOperation('delete', path);
        return;
      }
      await this.deleteFileCore(path);
    } catch (e) {
      console.error(`[VaultSync] Delete failed for ${path}:`, e);
      await this.queuePendingOperation('delete', path);
    }
  }

  /** Push a deletion to the server. Throws on failure (callers decide about queueing). */
  private async deleteFileCore(path: string): Promise<void> {
    const deleteSeq = await this.apiClient.delete(this.toServerPath(path));

    await this.localState.deleteFileHash(path);
    // Remember the delete's seq (survives the deletion) so a later re-create
    // at this path proves we observed the deletion → genuine recreation.
    await this.localState.setFileSeq(path, deleteSeq);

    await this.fileOps.cleanupEmptyParentFolders(path);
  }

  async requestFullSync(): Promise<void> {
    if (this.destroyed) return;
    if (!this.isConnected()) {
      this.status.error('не подключено');
      return;
    }

    if (this.isSyncing) {
      console.debug('[VaultSync] Sync already in progress, skipping');
      return;
    }

    this.isSyncing = true;
    this.status.begin('синхронизация…');
    try {
      this.lowestFailedSeq = null; // full pass retries everything; failures re-note below
      const response = await this.stompClient.requestSync(0);

      const summary = await this.processFullSync(response);
      await this.advanceLastSeq(response.currentSeq);

      this.status.done(summary);
    } catch (e) {
      console.error('[VaultSync] Full sync failed:', e);
      this.status.error('синхронизация не удалась');
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Pull what changed on the server since this device's last seen seq, instead of the whole
   * manifest. Sends the persisted lastSeq; the SERVER decides what comes back:
   *   - a sparse delta (files/tombstones with seq > lastSeq) → applied additively like batched
   *     real-time pushes, never inferring deletions from absence (so it can't mass-delete);
   *   - the full state (response.fullState) → when lastSeq is 0 (new device) or below the
   *     server's tombstone floor (so stale it may have missed a pruned deletion) → reconciled
   *     by absence via {@link processFullSync}.
   * Either way the client never guesses; it branches on the server's `fullState` flag. Local
   * edits/deletes still flow out via the FileWatcher and pending-ops queue, so this is the
   * complete steady-state sync — no per-session full-scan, which is what removed the mobile
   * "indexing" churn.
   */
  async requestIncrementalSync(): Promise<void> {
    if (this.destroyed) return;
    if (!this.isConnected()) {
      this.status.error('не подключено');
      return;
    }
    if (this.isSyncing) {
      console.debug('[VaultSync] Sync already in progress, skipping');
      return;
    }

    this.isSyncing = true;
    this.status.begin('синхронизация…');
    try {
      this.lowestFailedSeq = null; // this pass retries everything; failures re-note below
      const lastSeq = await this.localState.getLastSeq();
      const response = await this.stompClient.requestSync(lastSeq);
      const summary = response.fullState
        ? await this.processFullSync(response)
        : await this.processIncrementalSync(response);
      // Clamped below the lowest failed seq (if any), so a failed download stays
      // inside the next delta instead of being skipped forever.
      await this.advanceLastSeq(response.currentSeq);
      this.status.done(summary);
    } catch (e) {
      console.error('[VaultSync] Incremental sync failed:', e);
      this.status.error('синхронизация не удалась');
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Apply a sparse delta (files + tombstones with seq > the requested lastSeq). Mirrors the
   * real-time push handlers, batched: changed files are downloaded (skipping any already in
   * sync to avoid re-fetching our own echoed uploads), tombstoned files are deleted using
   * the SAME guards as {@link handleRemoteFileDelete} (never touch a path we never synced,
   * leave device-local .obsidian/* alone). Absence is NOT treated as deletion.
   */
  private async processIncrementalSync(response: SyncResponse): Promise<string> {
    const files = response.files || [];
    const tombstoneList = response.tombstones || [];
    console.debug(`[VaultSync] Incremental delta: ${files.length} files, ${tombstoneList.length} tombstones, currentSeq=${response.currentSeq}`);

    let downloaded = 0;
    let downloadFailed = 0;
    let deleted = 0;
    // Every real path this delta touches — the offline-deletion pass below must not
    // reason about paths the server changed after our lastSeq.
    const deltaPaths = new Set<string>();

    for (const f of files) {
      const path = this.toRealPath(f.path);
      if (path === null || !SyncFilter.shouldSync(path)) continue;
      deltaPaths.add(path);
      await this.localState.setFileSeq(path, f.seq);

      // Already in sync (e.g. our own upload echoed back, or a redundant delta) — don't
      // re-download. This is what keeps reconnects from re-pulling unchanged content.
      const knownHash = await this.localState.getFileHash(path);
      if (knownHash === f.hash) continue;

      // Content changed server-side — clear any stale "can't decrypt" mark first.
      this.undecryptable.delete(path);
      this.beginRemote(path);
      try {
        const ok = await this.downloadFile(path);
        if (ok) {
          downloaded++;
        } else {
          downloadFailed++;
          this.noteFailedSeq(f.seq); // keep this file inside the next delta
        }
      } finally {
        this.endRemote(path);
      }
    }

    for (const t of tombstoneList) {
      const path = this.toRealPath(t.path);
      if (path === null || !SyncFilter.shouldSync(path)) continue;
      deltaPaths.add(path);
      await this.localState.setFileSeq(path, t.seq);

      // Same guards as handleRemoteFileDelete: never delete a path we never synced (a
      // tombstone for content this device never had), and leave device-local .obsidian/*
      // (non-plugin) config alone.
      if (path.startsWith('.obsidian/') && !path.startsWith('.obsidian/plugins/')) continue;
      const knownHash = await this.localState.getFileHash(path);
      const isPlugin = path.startsWith('.obsidian/plugins/');
      if (!knownHash && !isPlugin) continue;

      this.beginRemote(path);
      try {
        const removed = await this.applyRemoteDelete(path);
        if (removed) deleted++;
      } catch (e) {
        console.error(`[VaultSync] Incremental delete failed for ${path}:`, e);
      } finally {
        this.endRemote(path);
      }
    }

    // Deletions made while the plugin wasn't running (vault reorganized with Obsidian
    // closed) leave no watcher event and no pending op — the only trace is a localState
    // hash for a path that's gone from disk. This is the one place that can push them
    // safely: for every path NOT in this delta the server copy is unchanged since our
    // lastSeq, i.e. this device had seen exactly the version the server still holds, so
    // its local absence is a genuine user deletion — not the stale-device case that
    // forbids absence-inference in full sync.
    let offlinePushed = 0;
    if (!this.offlineDeletionScanDone) {
      offlinePushed = await this.pushOfflineDeletions(deltaPaths);
    }

    const failed = downloadFailed;
    const summary = `↓${downloaded}${downloadFailed > 0 ? '(❌' + downloadFailed + ')' : ''} ×${deleted}${offlinePushed > 0 ? ` ↑×${offlinePushed}` : ''}`;
    console.log(`[VaultSync] Incremental sync complete: ${summary} (currentSeq=${response.currentSeq})`);
    return failed > 0 ? `${summary} · ⚠️ ${failed} с ошибкой` : `готово · ${summary}`;
  }

  /** One pass per session: offline deletions can only predate startup, and the watcher
   *  covers everything after it. Left false when a pass couldn't run (listing errors)
   *  so a later delta retries. */
  private offlineDeletionScanDone = false;

  /**
   * Detect files deleted while the plugin was off and push those deletions to the
   * server. A candidate must satisfy ALL of:
   *   - localState has a hash → this device HAD the file fully synced at some point;
   *   - the path is absent from every local listing AND from a direct adapter probe;
   *   - the path is not in the current delta → the server copy is unchanged since our
   *     lastSeq, so we're deleting exactly the version this device had seen.
   * Guards: any failed directory listing skips the pass (incomplete inventory must not
   * fabricate deletions), and a mass-deletion valve refuses to act when the local state
   * looks broken (empty vault / most known files "missing") rather than cleaned up.
   */
  private async pushOfflineDeletions(deltaPaths: Set<string>): Promise<number> {
    SyncFilter.resetListingErrors();
    const vaultPaths = this.app.vault.getFiles().map(f => f.path).filter(p => SyncFilter.shouldSync(p));
    const obsidianPaths = (await SyncFilter.listObsidianFiles(this.app)).filter(p => SyncFilter.shouldSync(p));
    const hiddenPaths = (await SyncFilter.listHiddenFiles(this.app)).filter(p => SyncFilter.shouldSync(p));
    const allHiddenInVault = (await SyncFilter.listAllHiddenFilesInVault(this.app)).filter(p => SyncFilter.shouldSync(p));
    const localFilePaths = new Set<string>([...vaultPaths, ...obsidianPaths, ...hiddenPaths, ...allHiddenInVault]);
    if (SyncFilter.getListingErrors() > 0) {
      console.warn(`[VaultSync] ${SyncFilter.getListingErrors()} listing(s) failed — offline-deletion scan postponed`);
      return 0;
    }

    const localHashes = await this.localState.getAllHashes();
    const candidates: string[] = [];
    for (const [path] of localHashes) {
      if (localFilePaths.has(path)) continue;
      if (deltaPaths.has(path)) continue;
      if (!SyncFilter.shouldSync(path)) continue;
      // Non-plugin .obsidian/* is device-local territory — never inferred (same
      // exemption as the full-sync reconcile and the tombstone handlers).
      if (path.startsWith('.obsidian/') && !path.startsWith('.obsidian/plugins/')) continue;
      if (await this.fileOps.exists(path)) continue; // listing raced the FS — it's there
      candidates.push(path);
    }

    // SAFETY VALVE: an empty vault listing or "most known files missing" is a broken
    // mount / wrong vault / listing bug, never a real cleanup — refuse to mass-delete.
    if (candidates.length > 0 && (localFilePaths.size === 0 || candidates.length > Math.max(20, localHashes.size / 2))) {
      console.error(`[VaultSync] Offline-deletion scan ABORTED: ${candidates.length}/${localHashes.size} known files missing (local listing: ${localFilePaths.size} files) — refusing to mass-delete`);
      this.offlineDeletionScanDone = true;
      return 0;
    }

    let pushed = 0;
    for (const path of candidates) {
      console.log(`[VaultSync] Deleted while plugin was off — pushing deletion: ${path}`);
      try {
        await this.deleteFile(path);
        pushed++;
      } catch (e) {
        console.error(`[VaultSync] Failed to push offline deletion: ${path}`, e);
      }
    }
    this.offlineDeletionScanDone = true;
    if (pushed > 0) console.log(`[VaultSync] Pushed ${pushed} offline deletion(s) to server`);
    return pushed;
  }

  /**
   * Whether a tombstone should delete the local file at `path`. Thin wrapper
   * over the pure, unit-tested decision in TombstoneLogic, so every tombstone
   * pass shares ONE source of truth — their past divergence is what silently
   * deleted freshly-added files.
   */
  private tombstoneApplies(
    path: string,
    localHashes: Map<string, string>,
    serverFiles: Map<string, unknown>,
  ): boolean {
    return decideTombstone({
      path,
      syncedBefore: !!localHashes.get(path),
      serverHasLive: serverFiles.has(path),
    });
  }

  private async processFullSync(response: SyncResponse): Promise<string> {
    try {
      const files = response.files || [];
      const tombstoneList = response.tombstones || [];

      console.debug(`[VaultSync] Full sync received: ${files.length} files, ${tombstoneList.length} tombstones, currentSeq=${response.currentSeq}`);

    // Server paths are encrypted — decrypt each to the real vault path (and skip any
    // that won't decrypt: plaintext entries from a non-encrypting writer like duq).
    const serverFiles = new Map<string, typeof files[number]>();
    let undecryptablePaths = 0;
    for (const f of files) {
      const real = this.toRealPath(f.path);
      if (real === null) { undecryptablePaths++; continue; }
      if (!SyncFilter.shouldSync(real)) continue;
      serverFiles.set(real, { ...f, path: real });
    }

    // SAFETY VALVE (wrong key/salt): with a bad key every server path fails to decrypt,
    // serverFiles comes out empty, and the "deleted on server → delete locally" pass
    // below would interpret that as "everything was deleted" and WIPE THE LOCAL VAULT.
    // A vault where most paths won't decrypt is a key problem, never a real state.
    if (this.cipher && files.length > 0 && undecryptablePaths > files.length / 2) {
      this.reportKeyMismatch(`${undecryptablePaths}/${files.length} server paths`);
      throw new Error(`E2EE key mismatch: ${undecryptablePaths}/${files.length} server paths undecryptable — full sync aborted`);
    }

    const tombstones = new Set<string>();
    for (const t of tombstoneList) {
      const real = this.toRealPath(t.path);
      if (real !== null && SyncFilter.shouldSync(real)) tombstones.add(real);
    }

    SyncFilter.resetListingErrors();
    const vaultFiles = this.app.vault.getFiles().filter(f => SyncFilter.shouldSync(f.path));
    const obsidianPaths = (await SyncFilter.listObsidianFiles(this.app)).filter(p => SyncFilter.shouldSync(p));
    const hiddenPaths = (await SyncFilter.listHiddenFiles(this.app)).filter(p => SyncFilter.shouldSync(p));
    const allHiddenInVault = (await SyncFilter.listAllHiddenFilesInVault(this.app)).filter(p => SyncFilter.shouldSync(p));
    const localFilePaths = new Set<string>([...vaultFiles.map(f => f.path), ...obsidianPaths, ...hiddenPaths, ...allHiddenInVault]);
    // A failed directory listing means localFilePaths is INCOMPLETE — treating a
    // missing entry as "user deleted it" would push bogus deletions to the server.
    const localListingIncomplete = SyncFilter.getListingErrors() > 0;
    if (localListingIncomplete) {
      console.warn(`[VaultSync] ${SyncFilter.getListingErrors()} directory listing(s) failed — deletion inference disabled this pass`);
    }
    const localHashes = await this.localState.getAllHashes();

    // Record the seq the server reports for every path (live files AND
    // tombstones) so this device's per-path version is always current — this is
    // what later lets an upload prove genuine recreation (baseSeq >= tomb.seq).
    for (const f of serverFiles.values()) await this.localState.setFileSeq(f.path, f.seq);
    for (const t of tombstoneList) {
      const real = this.toRealPath(t.path);
      if (real !== null && SyncFilter.shouldSync(real)) await this.localState.setFileSeq(real, t.seq);
    }

    console.log(`[VaultSync] ========== FULL SYNC START ==========`);
    console.log(`[VaultSync] Server: ${serverFiles.size} files, ${tombstones.size} tombstones`);
    console.log(`[VaultSync] Local: ${localFilePaths.size} files (vault: ${vaultFiles.length}, obsidian: ${obsidianPaths.length}, hidden: ${hiddenPaths.length}, allHidden: ${allHiddenInVault.length})`);
    console.log(`[VaultSync] LocalState: ${localHashes.size} stored hashes`);

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
    }

    let downloaded = 0;
    let downloadFailed = 0;
    let uploaded = 0;
    let uploadFailed = 0;
    let deleted = 0;

    for (const [path] of localHashes) {
      if (localListingIncomplete) break; // can't trust absence — skip deletion inference
      const isProtectedObsidian = path.startsWith('.obsidian/') && !path.startsWith('.obsidian/plugins/');
      if (!localFilePaths.has(path) && !isProtectedObsidian) {
        // CRITICAL: only treat a localState-hash-without-local-file as a user deletion to
        // push upstream when the SERVER also no longer has it live. If the server still has
        // the file, our missing local copy is a DOWNLOAD case (incomplete/lost download),
        // NOT a deletion — pushing a delete here would wipe a live file off the server (and
        // every other device) just because this one device lost its on-disk copy while its
        // localState lagged. That is exactly how a stale device nuked notes that still
        // existed everywhere else. Leave it: the toDownload pass below will refetch it.
        if (serverFiles.has(path)) {
          console.debug(`[VaultSync] Local copy missing but server has it live — will download, not delete: ${path}`);
          continue;
        }
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
      this.status.update(`загрузка ${toDownload.length} файлов…`);
    }

    for (let i = 0; i < toDownload.length; i++) {
      const { path } = toDownload[i];

      if ((i + 1) % 10 === 0 || i === toDownload.length - 1) {
        console.debug(`[VaultSync] Downloading progress: ${i + 1}/${toDownload.length}`);
        this.status.update(`загрузка ${i + 1}/${toDownload.length}…`);
      }

      this.beginRemote(path);
      try {
        const success = await this.downloadFile(path);
        if (success) {
          downloaded++;
        } else {
          downloadFailed++;
          this.noteFailedSeq(serverFiles.get(path)?.seq);
          console.error(`[VaultSync] Failed to download after retries: ${path}`);
        }
      } finally {
        this.endRemote(path);
      }

      if (i < toDownload.length - 1) {
        await this.sleep(50);
      }
    }

    // ONE tombstone pass (there used to be two near-identical ones — a divergence
    // magnet). Applied after uploads, below.
    const tombstonedToDelete: string[] = [];
    for (const path of tombstones) {
      if (this.tombstoneApplies(path, localHashes, serverFiles)) {
        tombstonedToDelete.push(path);
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
        // If the tombstone applies it's already queued for deletion. If it does
        // NOT apply (the user just re-added the file), resurrect it by uploading
        // so the server clears the tombstone and other devices get it back.
        if (!this.tombstoneApplies(path, localHashes, serverFiles)) {
          console.log(`[VaultSync] Newly-added file at tombstoned path, will upload (resurrect): ${path}`);
          toUpload.push(path);
        }
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

    if (toDeleteLocallyOld.length > 0) {
      this.status.update(`удаление ${toDeleteLocallyOld.length}…`);
    }

    for (const path of toDeleteLocallyOld) {
      this.beginRemote(path);
      try {
        // applyRemoteDelete keeps an unsynced local edit as a conflict copy.
        const removed = await this.applyRemoteDelete(path);
        if (removed) { deleted++; console.log(`[VaultSync] Deleted old file: ${path}`); }
      } catch (e) {
        console.error(`[VaultSync] Failed to delete old file: ${path}`, e);
      } finally {
        this.endRemote(path);
      }
    }

    if (toUpload.length > 0) {
      this.status.update(`отправка ${toUpload.length}…`);
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

    if (tombstonedToDelete.length > 0) {
      this.status.update(`удаление ${tombstonedToDelete.length}…`);
    }

    for (const path of tombstonedToDelete) {
      this.beginRemote(path);
      try {
        const removed = await this.applyRemoteDelete(path);
        if (removed) { deleted++; console.log(`[VaultSync] Deleted tombstoned file: ${path}`); }
      } catch (e) {
        console.error(`[VaultSync] Failed to delete tombstoned file: ${path}`, e);
      } finally {
        this.endRemote(path);
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

    const failed = downloadFailed + uploadFailed;
    const summary = `Sync complete: ↓${downloaded}${downloadFailed > 0 ? '(❌' + downloadFailed + ')' : ''} ↑${uploaded}${uploadFailed > 0 ? '(❌' + uploadFailed + ')' : ''} ×${deleted}`;
    console.log(`[VaultSync] ========== FULL SYNC END ==========`);
    console.log(`[VaultSync] ${summary}`);
    console.log(`[VaultSync] Downloaded: ${downloaded}, Uploaded: ${uploaded}, Deleted: ${deleted}`);
    console.log(`[VaultSync] Failures: download=${downloadFailed}, upload=${uploadFailed}`);

    const toast = `↓${downloaded} ↑${uploaded} ×${deleted}` + (failed > 0 ? ` · ⚠️ ${failed} с ошибкой` : '');
    return failed > 0 ? toast : `готово · ${toast}`;
    } catch (e: any) {
      console.error('[VaultSync] processFullSync error:', e);
      throw e;
    }
  }

  private async queuePendingOperation(type: 'upload' | 'delete', path: string): Promise<void> {
    const op: PendingOperation = {
      // Deterministic id: re-queueing the same (type, path) upserts the existing op
      // (LocalState uses put) — a repeatedly failing operation never piles up copies.
      id: `${type}:${path}`,
      type,
      path,
      timestamp: Date.now(),
      retries: 0,
    };
    await this.localState.addPendingOperation(op);
  }

  /** A pending op that keeps failing is dropped after this many attempts — the file is
   *  still local and the next full sync reconciles it, so nothing is lost. */
  private static readonly PENDING_OP_MAX_RETRIES = 20;

  private async processPendingOperations(): Promise<void> {
    if (this.destroyed) return;
    const operations = await this.localState.getPendingOperations();
    if (operations.length === 0) return;

    for (const op of operations) {
      try {
        if (op.type === 'upload') {
          // Core variant THROWS on transport failure (the wrapper would silently
          // re-queue and this loop would then wrongly remove the op). It handles both
          // vault-indexed files and adapter-only paths (.obsidian/*, hidden files) —
          // an offline config edit is a valid pending upload without being a TFile.
          await this.uploadByPathCore(op.path);
        } else if (op.type === 'delete') {
          await this.deleteFileCore(op.path);
        }
        await this.localState.removePendingOperation(op.id);
      } catch (e) {
        console.error(`[VaultSync] Failed to process pending op:`, op, e);
        op.retries = (op.retries ?? 0) + 1;
        if (op.retries >= SyncManager.PENDING_OP_MAX_RETRIES) {
          console.error(`[VaultSync] Dropping pending op after ${op.retries} attempts: ${op.type} ${op.path}`);
          await this.localState.removePendingOperation(op.id);
        } else {
          await this.localState.addPendingOperation(op); // upsert with the bumped retry count
        }
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

    const localHash = await this.serverHash(path, read.content);

    // Already in sync by content (blob hashes match). Seed localState with the
    // server hash and return early — otherwise a stale pre-migration plaintext
    // hash in lastKnownHash makes ConflictResolver think the file changed and
    // re-uploads the ENTIRE vault on first launch after the encryption cutover
    // (OOM on mobile). This makes the cutover a no-op for unchanged files.
    if (localHash === serverFile.hash) {
      await this.localState.setFileHash(path, localHash);
      return 'noop';
    }

    // Conflict-copy preservation is handled centrally in downloadFile (covers both the
    // full-sync download here and real-time broadcast downloads), so just decide here.
    return ConflictResolver.resolve(
      path,
      { hash: localHash, mtime: read.mtime },
      { hash: serverFile.hash, mtime: serverFile.mtime },
      lastKnownHash
    );
  }

  /** Write the local content to a "(conflict …)" side file so a conflict never loses data. */
  private async saveConflictCopy(path: string, localContent: ArrayBuffer): Promise<void> {
    if (localContent.byteLength === 0) return;
    const dot = path.lastIndexOf('.');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const suffix = ` (conflict ${this.settings.deviceId} ${stamp})`;
    const conflictPath = dot > 0 ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`;
    await this.fileOps.writeBinary(conflictPath, localContent);
    new Notice(`Vault Sync: conflict on ${path.split('/').pop()} — kept your copy`);
  }

  private async uploadByPath(path: string): Promise<void> {
    try {
      if (!this.isConnected()) {
        // Only queue when there is actually something to send.
        if (await this.hasUnsyncedContent(path)) await this.queuePendingOperation('upload', path);
        return;
      }
      await this.uploadByPathCore(path);
    } catch (e) {
      console.error(`[VaultSync] uploadByPath failed for ${path}:`, e);
      await this.queuePendingOperation('upload', path);
    }
  }

  /** True when the local content at path differs from what this device last synced. */
  private async hasUnsyncedContent(path: string): Promise<boolean> {
    if (!SyncFilter.shouldSync(path)) return false;
    const read = await this.fileOps.readBinary(path);
    if (!read) return false;
    const hash = await this.serverHash(path, read.content);
    return (await this.localState.getFileHash(path)) !== hash;
  }

  /**
   * Upload a path's current content. Conflict resolution (409) is handled here; any
   * transport failure THROWS so callers (fire-and-forget wrapper vs pending-ops loop)
   * decide how to queue/retry it.
   */
  private async uploadByPathCore(path: string): Promise<void> {
    if (this.remoteWrites.has(path)) return;
    if (!SyncFilter.shouldSync(path)) return;

    const read = await this.fileOps.readBinary(path);
    if (!read) return;
    const { content, mtime } = read;

    const hash = await this.serverHash(path, content);
    const existingHash = await this.localState.getFileHash(path);
    if (existingHash === hash) return;

    const baseSeq = await this.localState.getFileSeq(path);
    try {
      // Upload the encrypted blob (or plaintext when E2EE is off); `hash` is already
      // in the matching (blob | plaintext) hash space so server concurrency holds.
      const payload = this.encodeForUpload(path, content);
      const seq = await this.apiClient.upload(this.toServerPath(path), payload, hash, mtime, existingHash ?? '', baseSeq);
      await this.localState.setFileHash(path, hash);
      await this.localState.setFileSeq(path, seq);
    } catch (e) {
      if (e instanceof ConflictError) {
        await this.reconcileConflict(path, content, e.deleted);
        return;
      }
      throw e;
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
      this.beginRemote(path);
      try {
        // The rejected local content is preserved below in the caller-independent way:
        // applyRemoteDelete's edit-guard sees the unsynced content and keeps a copy.
        await this.applyRemoteDelete(path);
      } catch (e) {
        console.error(`[VaultSync] Failed to honor remote deletion of ${path}:`, e);
      } finally {
        this.endRemote(path);
      }
      return;
    }

    console.warn(`[VaultSync] Upload conflict for ${path} — adopting server version, preserving local copy`);

    this.beginRemote(path);
    try {
      await this.downloadFile(path);
    } finally {
      this.endRemote(path);
    }

    const serverContent = await this.fileOps.readBinary(path);
    const sameAsServer = serverContent
      && (await this.serverHash(path, serverContent.content)) === (await this.serverHash(path, localContent));

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
    this.destroyed = true;
    this.fileWatcher.stop();

    for (const timeout of this.pendingChanges.values()) {
      clearTimeout(timeout);
    }
    this.pendingChanges.clear();
    this.remoteWrites.clear();

    this.disconnect();
    this.localState.close();
  }
}

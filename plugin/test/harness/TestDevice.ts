import { SyncManager } from '../../sync/SyncManager';
import { ConflictError } from '../../sync/SyncApiClient';
import { PendingOperation, ServerMessage, SyncResponse, VaultSyncSettings, DEFAULT_SETTINGS } from '../../types';
import { FakeApp, FakeFsStore, makeFsStore, toArrayBuffer } from './FakeApp';
import { InMemoryServer } from './InMemoryServer';

/** LocalState drop-in over plain Maps; the backing object survives device restarts. */
export interface LocalStateStore {
  state: Map<string, unknown>;
  hashes: Map<string, string>;
  seqs: Map<string, number>;
  pending: Map<string, PendingOperation>;
}

export function makeLocalStateStore(): LocalStateStore {
  return { state: new Map(), hashes: new Map(), seqs: new Map(), pending: new Map() };
}

class FakeLocalState {
  constructor(private s: LocalStateStore) {}
  async init(): Promise<void> {}
  close(): void {}
  async getLastSeq(): Promise<number> { return (this.s.state.get('lastSeq') as number) ?? 0; }
  async setLastSeq(seq: number): Promise<void> { this.s.state.set('lastSeq', seq); }
  async getFileHash(path: string): Promise<string | null> { return this.s.hashes.get(path) ?? null; }
  async setFileHash(path: string, hash: string): Promise<void> { this.s.hashes.set(path, hash); }
  async deleteFileHash(path: string): Promise<void> { this.s.hashes.delete(path); }
  async getFileSeq(path: string): Promise<number> { return this.s.seqs.get(path) ?? 0; }
  async setFileSeq(path: string, seq: number): Promise<void> {
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq <= 0) return;
    if (seq > (this.s.seqs.get(path) ?? 0)) this.s.seqs.set(path, seq);
  }
  async getAllHashes(): Promise<Map<string, string>> { return new Map(this.s.hashes); }
  async addPendingOperation(op: PendingOperation): Promise<void> { this.s.pending.set(op.id, op); }
  async getPendingOperations(): Promise<PendingOperation[]> {
    return [...this.s.pending.values()].sort((a, b) => a.timestamp - b.timestamp);
  }
  async removePendingOperation(id: string): Promise<void> { this.s.pending.delete(id); }
  async clearPendingOperations(): Promise<void> { this.s.pending.clear(); }
}

class FakeApiClient {
  constructor(private server: InMemoryServer, private deviceId: string) {}
  async upload(path: string, content: ArrayBuffer, hash: string, mtime: number, baseHash = '', baseSeq = 0): Promise<number> {
    const r = this.server.upload(path, new Uint8Array(content), hash, mtime, baseHash, baseSeq, this.deviceId);
    if (r.status === 409) throw new ConflictError(path, r.currentHash ?? '', r.error === 'deleted');
    return r.seq;
  }
  async download(path: string): Promise<{ content: ArrayBuffer; hash: string } | null> {
    const r = this.server.download(path);
    if (!r) return null;
    return { content: toArrayBuffer(r.content), hash: r.hash };
  }
  async delete(path: string): Promise<number> {
    return this.server.delete(path, this.deviceId).seq;
  }
}

class FakeStompClient {
  private connected = false;
  private messageHandler: ((msg: ServerMessage) => void) | null = null;
  private connectionHandler: ((state: string) => void) | null = null;

  constructor(private server: InMemoryServer, private deviceId: string) {}

  setMessageHandler(h: (msg: ServerMessage) => void): void { this.messageHandler = h; }
  setConnectionHandler(h: (state: string) => void): void { this.connectionHandler = h; }
  isConnected(): boolean { return this.connected; }

  /** Connect WITHOUT firing the auto catch-up chain — tests drive syncs explicitly
   *  so every await is deterministic. */
  goOnline(): void {
    this.connected = true;
    this.server.subscribe(this.deviceId, (msg) => { if (this.connected) this.messageHandler?.(msg); });
  }
  async connect(): Promise<void> {
    this.goOnline();
    this.connectionHandler?.('connected');
  }
  disconnect(): void {
    this.connected = false;
    this.server.unsubscribe(this.deviceId);
    this.connectionHandler?.('disconnected');
  }
  async requestSync(lastSeq: number): Promise<SyncResponse> {
    if (!this.connected) throw new Error('Not connected');
    return this.server.sync(lastSeq);
  }
}

/**
 * One simulated device running the REAL SyncManager/FileWatcher/FileOperationService
 * against an in-memory vault and server. FS and localState backing survive restart()
 * — that's what makes "did something offline, reopened Obsidian" scenarios possible.
 */
export class TestDevice {
  readonly app: FakeApp;
  sm!: SyncManager;
  stomp!: FakeStompClient;
  private readonly settings: VaultSyncSettings;

  constructor(
    readonly server: InMemoryServer,
    readonly deviceId: string,
    readonly fs: FakeFsStore = makeFsStore(),
    readonly local: LocalStateStore = makeLocalStateStore(),
  ) {
    this.app = new FakeApp(fs);
    this.settings = { ...DEFAULT_SETTINGS, deviceId, debounceMs: 0, retryAttempts: 1, autoConnect: false };
  }

  /** Boot the plugin core: real SyncManager with fake transport/state injected. */
  async start(): Promise<void> {
    this.sm = new SyncManager(this.app as any, this.settings);
    const anySm = this.sm as any;
    anySm.localState = new FakeLocalState(this.local);
    anySm.apiClient = new FakeApiClient(this.server, this.deviceId);
    this.stomp = new FakeStompClient(this.server, this.deviceId);
    this.stomp.setMessageHandler((msg) => void anySm.handleServerMessage(msg));
    this.stomp.setConnectionHandler((state) => anySm.handleConnectionChange(state));
    anySm.stompClient = this.stomp;

    await this.sm.init();
    // Deterministic scanning: kill the 10s interval, drive scans by hand.
    (this.sm as any).fileWatcher.stop();
    await (this.sm as any).fileWatcher.buildBaseline();
  }

  /** Go online and run the startup catch-up exactly like handleConnectionChange does,
   *  but awaited so tests are deterministic. */
  async connectAndSync(): Promise<void> {
    this.stomp.goOnline();
    await this.sm.requestIncrementalSync();
    await (this.sm as any).processPendingOperations();
  }

  /** Mimic Obsidian's vault-load behaviour: a 'create' event fires for every indexed
   *  file on startup (this is how files created while the app was closed get uploaded
   *  — the hash guard in uploadByPathCore skips everything already synced). */
  async emitVaultLoadCreates(): Promise<void> {
    for (const f of this.app.vault.getFiles()) {
      this.sm.queueFileChange(f);
    }
    await this.flushDebounce();
  }

  /** One watcher poll + debounce flush (debounceMs=0 → next macrotask). */
  async scan(): Promise<void> {
    await (this.sm as any).fileWatcher.forceScan();
    await this.flushDebounce();
  }

  async flushDebounce(): Promise<void> {
    // debounce timers are setTimeout(0); yield a few macrotasks so the queued
    // upload/delete promises (fired via `void`) settle too.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  }

  /** Local edits as the user would make them (through the vault, index in sync). */
  async writeLocal(path: string, text: string): Promise<void> {
    await this.app.vault.adapter.write(path, text);
  }

  async deleteLocal(path: string): Promise<void> {
    await this.app.vault.adapter.remove(path);
  }

  async readLocal(path: string): Promise<string | null> {
    try {
      const buf = await this.app.vault.adapter.readBinary(path);
      return new TextDecoder().decode(buf);
    } catch {
      return null;
    }
  }

  localPaths(): string[] {
    return [...this.fs.files.keys()].sort();
  }

  stop(): void {
    this.stomp?.disconnect();
    this.sm?.destroy();
  }
}

/** Edit the raw FS while the device is STOPPED — "changed things with Obsidian closed". */
export function offlineWrite(fs: FakeFsStore, path: string, text: string): void {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) fs.folders.add(parts.slice(0, i).join('/'));
  fs.files.set(path, { data: new TextEncoder().encode(text), mtime: Date.now() });
}

export function offlineDelete(fs: FakeFsStore, path: string): void {
  fs.files.delete(path);
}

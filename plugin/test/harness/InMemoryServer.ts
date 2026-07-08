import { FileInfo, ServerMessage, SyncResponse, TombstoneInfo } from '../../types';

export interface ServerFile {
  content: Uint8Array;
  hash: string;
  mtime: number;
  seq: number;
}

export type UploadResult =
  | { status: 200; seq: number }
  | { status: 409; error: 'conflict' | 'deleted'; currentHash?: string; deletedSeq?: number };

/**
 * Behavioural mirror of the real server (FileController + SyncService), kept
 * deliberately small: seq counter, live files, tombstones, tombstone floor,
 * resurrection check on upload (baseSeq vs tombstone seq), optimistic
 * concurrency (baseHash), sparse delta vs full-state promotion below the floor,
 * and broadcasts to every connected device except the origin.
 */
export class InMemoryServer {
  private seq = 0;
  readonly files = new Map<string, ServerFile>();
  readonly tombstones = new Map<string, { seq: number; deletedAt: number }>();
  tombstoneFloor = 0;

  private subscribers = new Map<string, (msg: ServerMessage) => void>();

  subscribe(deviceId: string, handler: (msg: ServerMessage) => void): void {
    this.subscribers.set(deviceId, handler);
  }

  unsubscribe(deviceId: string): void {
    this.subscribers.delete(deviceId);
  }

  private broadcast(origin: string, msg: ServerMessage): void {
    for (const [deviceId, handler] of this.subscribers) {
      if (deviceId === origin) continue; // the real client filters its own deviceId
      handler(msg);
    }
  }

  /** Mirrors FileController.uploadFinalize. */
  upload(path: string, content: Uint8Array, hash: string, mtime: number, baseHash: string, baseSeq: number, deviceId: string): UploadResult {
    const tomb = this.tombstones.get(path);
    if (tomb) {
      if (baseSeq !== 0 && baseSeq < tomb.seq) {
        return { status: 409, error: 'deleted', deletedSeq: tomb.seq };
      }
    }
    const existing = this.files.get(path);
    if (existing && baseHash !== '') {
      if (existing.hash !== hash && existing.hash !== baseHash) {
        return { status: 409, error: 'conflict', currentHash: existing.hash };
      }
    }
    const seq = ++this.seq;
    this.files.set(path, { content: content.slice(0), hash, mtime, seq });
    if (tomb) this.tombstones.delete(path); // "tombstone cleared after store"
    this.broadcast(deviceId, {
      type: 'file_changed', path, hash, mtime, size: content.byteLength, seq, deviceId,
    });
    return { status: 200, seq };
  }

  /** Mirrors SyncService.processFileDelete — idempotent for a missing file. */
  delete(path: string, deviceId: string): { seq: number } {
    const seq = ++this.seq;
    this.files.delete(path);
    this.tombstones.set(path, { seq, deletedAt: Date.now() });
    this.broadcast(deviceId, { type: 'file_deleted', path, seq, deviceId });
    return { seq };
  }

  download(path: string): { content: Uint8Array; hash: string } | null {
    const f = this.files.get(path);
    return f ? { content: f.content.slice(0), hash: f.hash } : null;
  }

  /** Mirrors SyncService.getChangesSince: sparse delta, or full state below the floor. */
  sync(lastSeq: number): SyncResponse {
    if (lastSeq < this.tombstoneFloor) return this.fullState();
    const files: FileInfo[] = [];
    for (const [path, f] of this.files) {
      if (f.seq > lastSeq) files.push({ path, hash: f.hash, mtime: f.mtime, size: f.content.byteLength, seq: f.seq });
    }
    const tombstones: TombstoneInfo[] = [];
    for (const [path, t] of this.tombstones) {
      if (t.seq > lastSeq) tombstones.push({ path, deletedAt: t.deletedAt, seq: t.seq });
    }
    return { type: 'sync_response', currentSeq: this.seq, files, tombstones, fullState: false };
  }

  fullState(): SyncResponse {
    const files: FileInfo[] = [];
    for (const [path, f] of this.files) {
      files.push({ path, hash: f.hash, mtime: f.mtime, size: f.content.byteLength, seq: f.seq });
    }
    const tombstones: TombstoneInfo[] = [];
    for (const [path, t] of this.tombstones) {
      tombstones.push({ path, deletedAt: t.deletedAt, seq: t.seq });
    }
    return { type: 'sync_response', currentSeq: this.seq, files, tombstones, fullState: true };
  }

  /** Mirrors the TTL cleanup: prune tombstones and raise the floor to the max pruned seq. */
  pruneAllTombstones(): void {
    for (const [path, t] of this.tombstones) {
      this.tombstoneFloor = Math.max(this.tombstoneFloor, t.seq);
      this.tombstones.delete(path);
    }
  }

  currentSeq(): number {
    return this.seq;
  }

  livePaths(): string[] {
    return [...this.files.keys()].sort();
  }
}

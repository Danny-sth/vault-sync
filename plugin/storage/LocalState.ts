import { PendingOperation } from '../types';

const DB_NAME = 'vault-sync';
const DB_VERSION = 2;

const STORE_STATE = 'state';
const STORE_HASHES = 'hashes';
const STORE_PENDING = 'pending';
/**
 * Per-path last-seen server `seq` (monotonic version). Unlike hashes, this
 * SURVIVES deletion: we keep the seq of the delete so that if the user later
 * re-creates the file, the upload can prove the device knew about the deletion
 * (baseSeq >= tombstone.seq) — the industry-standard version check that decides
 * genuine recreation vs. a stale offline re-push, instead of the broken
 * "does the device remember the old hash" heuristic.
 */
const STORE_SEQS = 'seqs';

/**
 * Persistent local state using IndexedDB
 */
export class LocalState {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;

        if (oldVersion < 1) {
          if (!db.objectStoreNames.contains(STORE_STATE)) {
            db.createObjectStore(STORE_STATE);
          }

          if (!db.objectStoreNames.contains(STORE_HASHES)) {
            db.createObjectStore(STORE_HASHES);
          }

          if (!db.objectStoreNames.contains(STORE_PENDING)) {
            const store = db.createObjectStore(STORE_PENDING, { keyPath: 'id' });
            store.createIndex('timestamp', 'timestamp', { unique: false });
          }
        }

        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains(STORE_SEQS)) {
            db.createObjectStore(STORE_SEQS);
          }
        }
      };
    });
  }

  private async get<T>(store: string, key: string): Promise<T | null> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(store, 'readonly');
      const request = tx.objectStore(store).get(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
    });
  }

  private async set<T>(store: string, key: string, value: T): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(store, 'readwrite');
      const request = tx.objectStore(store).put(value, key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  private async delete(store: string, key: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(store, 'readwrite');
      const request = tx.objectStore(store).delete(key);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getLastSeq(): Promise<number> {
    return (await this.get<number>(STORE_STATE, 'lastSeq')) ?? 0;
  }

  async setLastSeq(seq: number): Promise<void> {
    await this.set(STORE_STATE, 'lastSeq', seq);
  }

  async getFileHash(path: string): Promise<string | null> {
    return this.get<string>(STORE_HASHES, path);
  }

  async setFileHash(path: string, hash: string): Promise<void> {
    await this.set(STORE_HASHES, path, hash);
  }

  async deleteFileHash(path: string): Promise<void> {
    await this.delete(STORE_HASHES, path);
  }

  /** Last server seq this device saw for a path (0 if never). Survives deletion. */
  async getFileSeq(path: string): Promise<number> {
    return (await this.get<number>(STORE_SEQS, path)) ?? 0;
  }

  /** Record the latest seq seen for a path; never moves backwards. */
  async setFileSeq(path: string, seq: number): Promise<void> {
    if (typeof seq !== 'number' || seq <= 0) return;
    const current = await this.getFileSeq(path);
    if (seq > current) await this.set(STORE_SEQS, path, seq);
  }

  async getAllHashes(): Promise<Map<string, string>> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_HASHES, 'readonly');
      const request = tx.objectStore(STORE_HASHES).openCursor();
      const result = new Map<string, string>();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          result.set(cursor.key as string, cursor.value);
          cursor.continue();
        } else {
          resolve(result);
        }
      };
    });
  }

  async addPendingOperation(op: PendingOperation): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_PENDING, 'readwrite');
      const request = tx.objectStore(STORE_PENDING).add(op);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getPendingOperations(): Promise<PendingOperation[]> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_PENDING, 'readonly');
      const request = tx.objectStore(STORE_PENDING).index('timestamp').getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async removePendingOperation(id: string): Promise<void> {
    await this.delete(STORE_PENDING, id);
  }

  async clearPendingOperations(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_PENDING, 'readwrite');
      const request = tx.objectStore(STORE_PENDING).clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

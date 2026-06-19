import { requestUrl } from 'obsidian';
import { VaultSyncSettings } from '../types';

/**
 * Thrown when the server rejects an upload (HTTP 409) because this device was
 * editing a stale base version. Carries the server's current hash for reconciliation.
 */
export class ConflictError extends Error {
  /**
   * @param deleted - true when the server rejected the upload because the path has a live
   *   tombstone (it was deleted elsewhere). The client should delete locally, not download.
   */
  constructor(
    public readonly path: string,
    public readonly currentHash: string,
    public readonly deleted: boolean = false,
  ) {
    super(`Upload conflict for ${path}: server ${deleted ? 'deleted this path' : 'has a newer version'}`);
    this.name = 'ConflictError';
  }
}

/**
 * HTTP client for vault-sync server API.
 * Consolidates all REST API calls (upload, download, delete).
 */
export class SyncApiClient {
  constructor(private settings: VaultSyncSettings) {}

  /**
   * Convert WebSocket URL to HTTP base URL.
   */
  private get baseUrl(): string {
    return this.settings.serverUrl
      .replace('/ws', '')
      .replace('wss://', 'https://')
      .replace('ws://', 'http://');
  }

  /**
   * Get common headers for API requests.
   */
  private get headers(): Record<string, string> {
    return {
      'X-Auth-Token': this.settings.token,
      'X-Device-Id': this.settings.deviceId,
    };
  }

  /**
   * Encode path for URL while preserving slashes.
   */
  private encodePathForUrl(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
  }

  /**
   * Upload a file to the server.
   *
   * @param baseHash - the server hash this device last saw for the path. The server
   *   uses it for optimistic concurrency: if the server has since moved to a different
   *   version, the upload is rejected with HTTP 409 (thrown as ConflictError) so we
   *   reconcile instead of clobbering newer content.
   */
  async upload(
    path: string,
    content: ArrayBuffer,
    hash: string,
    mtime: number,
    baseHash = '',
    baseSeq = 0,
  ): Promise<number> {
    // Stream the encrypted blob to the server in ordered binary chunks — no base64,
    // no whole-file body. base64-in-JSON inflated big files ~6x into one giant string
    // that crossed the native bridge and OOM-killed Obsidian on mobile (and hit the
    // JSON size limit). Chunking bounds per-request memory regardless of file size.
    // baseSeq = highest server seq this device saw for the path (incl. its deletion);
    // the server uses it on the final chunk to tell genuine recreation from a stale re-push.
    const CHUNK_SIZE = 1024 * 1024; // 1 MiB
    const CONCURRENCY = 4; // parallel chunk uploads — bounded so memory stays small
    const total = Math.max(1, Math.ceil(content.byteLength / CHUNK_SIZE));
    const uploadId = `${this.settings.deviceId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      .replace(/[^A-Za-z0-9_.-]/g, '-');

    // Upload chunks concurrently — each is written at its byte offset, so order doesn't
    // matter. A shared cursor hands out the next chunk index to each worker.
    let nextIndex = 0;
    const uploadWorker = async (): Promise<void> => {
      for (;;) {
        const i = nextIndex++;
        if (i >= total) return;
        const offset = i * CHUNK_SIZE;
        const slice = content.slice(offset, Math.min(offset + CHUNK_SIZE, content.byteLength));
        const r = await requestUrl({
          url: `${this.baseUrl}/api/upload-chunk`,
          method: 'POST',
          headers: { ...this.headers, 'Content-Type': 'application/octet-stream', 'X-Upload-Id': uploadId, 'X-Chunk-Offset': String(offset) },
          body: slice,
          throw: false,
        });
        if (r.status !== 200) throw new Error(`Upload chunk @${offset} failed: ${r.status}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => uploadWorker()));

    // Commit: assemble + concurrency check happen here. baseSeq lets the server tell
    // genuine recreation from a stale re-push.
    const fin = await requestUrl({
      url: `${this.baseUrl}/api/upload-finalize`,
      method: 'POST',
      headers: {
        ...this.headers,
        'X-Path': encodeURIComponent(path),
        'X-Upload-Id': uploadId,
        'X-Hash': hash,
        'X-Mtime': String(mtime),
        'X-Base-Hash': baseHash,
        'X-Base-Seq': String(baseSeq),
      },
      throw: false,
    });
    if (fin.status === 409) {
      const body = fin.json || {};
      throw new ConflictError(path, body.currentHash || '', body.error === 'deleted');
    }
    if (fin.status !== 200) {
      throw new Error(`Upload finalize failed: ${fin.status}`);
    }
    return (fin.json && fin.json.seq) || 0;
  }

  /**
   * Download a file from the server.
   * @returns File content and hash on success, or `null` when the server returns 404
   *   (the path was already deleted upstream — a benign race, not an error). Any other
   *   non-200 status throws so the caller can retry.
   */
  async download(path: string): Promise<{ content: ArrayBuffer; hash: string } | null> {
    const encodedPath = this.encodePathForUrl(path);
    const url = `${this.baseUrl}/api/download/${encodedPath}`;

    const response = await requestUrl({
      url,
      method: 'GET',
      headers: this.headers,
      throw: false,
    });

    if (response.status === 404) {
      return null;
    }

    if (response.status !== 200) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const hash = response.headers['x-file-hash'] || response.headers['X-File-Hash'] || '';

    return {
      content: response.arrayBuffer,
      hash,
    };
  }

  /**
   * Delete a file on the server.
   */
  async delete(path: string): Promise<number> {
    const response = await requestUrl({
      url: `${this.baseUrl}/api/delete-json`,
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path }),
    });

    if (response.status !== 200) {
      throw new Error(`Delete failed: ${response.status}`);
    }
    // The deletion's seq — the caller records it so a later re-create proves
    // this device observed the deletion.
    return (response.json && response.json.seq) || 0;
  }

}

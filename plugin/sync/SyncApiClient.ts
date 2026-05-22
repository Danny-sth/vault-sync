import { requestUrl } from 'obsidian';
import { VaultSyncSettings } from '../types';

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
   */
  async upload(path: string, content: ArrayBuffer, hash: string, mtime: number): Promise<void> {
    const base64Content = this.arrayBufferToBase64(content);

    const response = await requestUrl({
      url: `${this.baseUrl}/api/upload-json`,
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path, content: base64Content, hash, mtime }),
    });

    if (response.status !== 200) {
      throw new Error(`Upload failed: ${response.status}`);
    }
  }

  /**
   * Download a file from the server.
   * @returns File content and hash, or null if download failed.
   */
  async download(path: string): Promise<{ content: ArrayBuffer; hash: string } | null> {
    const encodedPath = this.encodePathForUrl(path);
    const url = `${this.baseUrl}/api/download/${encodedPath}`;

    const response = await requestUrl({
      url,
      method: 'GET',
      headers: this.headers,
    });

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
  async delete(path: string): Promise<void> {
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
  }

  /**
   * Convert ArrayBuffer to Base64 string.
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

export interface FileChangedMessage {
  type: 'file_changed';
  path: string;
  hash: string;
  mtime: number;
  size: number;
  seq: number;
  deviceId: string;
}

export interface FileDeletedMessage {
  type: 'file_deleted';
  path: string;
  seq: number;
  deviceId: string;
}

export interface SyncResponse {
  type: 'sync_response';
  requestId?: string;
  currentSeq: number;
  files: FileInfo[];
  tombstones: TombstoneInfo[];
}

export interface FileInfo {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  seq: number;
}

export interface TombstoneInfo {
  path: string;
  deletedAt: number;
  seq: number;
}

export interface FileChangeRequest {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  deviceId: string;
}

export interface FileDeleteRequest {
  path: string;
  deviceId: string;
}

export interface SyncRequest {
  requestId: string;
  lastSeq: number;
  deviceId: string;
}

export type ServerMessage = FileChangedMessage | FileDeletedMessage | SyncResponse;

export interface PendingOperation {
  id: string;
  type: 'upload' | 'delete';
  path: string;
  timestamp: number;
  retries: number;
}

export interface VaultSyncSettings {
  serverUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
  autoConnect: boolean;
  syncOnStart: boolean;
  debounceMs: number;
  reconnectDelayMs: number;
  heartbeatIntervalMs: number;
  syncTimeoutMs: number;
  retryAttempts: number;
  // End-to-end encryption. When enabled, file content is encrypted client-side
  // (convergent AES-256-GCM, see VaultCipher) before upload and decrypted after
  // download — the server stores and hashes only ciphertext blobs. The passphrase
  // and salt never leave the device. Both passphrase and salt must match across
  // all devices, or they cannot read each other's files.
  encryptionEnabled: boolean;
  encryptionPassphrase: string;
  /** Per-vault salt, base64. Generated once; must be identical on every device. */
  encryptionSaltB64: string;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  serverUrl: '',
  token: '',
  deviceId: `device-${Math.random().toString(36).substring(2, 10)}`,
  deviceName: '',
  autoConnect: true,
  syncOnStart: true,
  debounceMs: 500,
  reconnectDelayMs: 5000,
  heartbeatIntervalMs: 10000,
  syncTimeoutMs: 120000,
  retryAttempts: 3,
  encryptionEnabled: false,
  encryptionPassphrase: '',
  encryptionSaltB64: '',
};

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

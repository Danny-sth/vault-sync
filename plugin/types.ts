// Server -> Client messages
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

// Client -> Server messages
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
  lastSeq: number;
  deviceId: string;
}

// Unified server message type
export type ServerMessage = FileChangedMessage | FileDeletedMessage | SyncResponse;

// Pending operation for offline queue
export interface PendingOperation {
  id: string;
  type: 'upload' | 'delete';
  path: string;
  timestamp: number;
  retries: number;
}

// Plugin settings
export interface VaultSyncSettings {
  serverUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
  autoConnect: boolean;
  syncOnStart: boolean;
  debounceMs: number;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  serverUrl: 'wss://90.156.230.49:8444/ws',
  token: '',
  deviceId: `device-${Math.random().toString(36).substring(2, 10)}`,
  deviceName: '',
  autoConnect: true,
  syncOnStart: true,
  debounceMs: 500,
};

// Connection state
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

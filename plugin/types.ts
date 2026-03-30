// Message types
export const MSG_TYPE_SYNC = 'sync';
export const MSG_TYPE_FILE_CHANGE = 'file_change';
export const MSG_TYPE_FILE_DELETE = 'file_delete';
export const MSG_TYPE_SYNC_RESPONSE = 'sync_response';
export const MSG_TYPE_CHANGE = 'change';
export const MSG_TYPE_DELETE = 'delete';
export const MSG_TYPE_CONFLICT = 'conflict';
export const MSG_TYPE_ERROR = 'error';

// Client → Server messages

export interface SyncRequest {
    type: 'sync';
    lastSeq: number;
}

export interface FileChangeRequest {
    type: 'file_change';
    path: string;
    content: string; // base64
    mtime: number;   // Unix milliseconds
    hash: string;    // SHA-256
}

export interface FileDeleteRequest {
    type: 'file_delete';
    path: string;
}

// Server → Client messages

export interface SyncResponse {
    type: 'sync_response';
    currentSeq: number;
    changes: ChangeItem[];
}

export interface ChangeItem {
    type: 'change' | 'delete';
    path: string;
    content?: string; // base64, only for 'change'
    mtime?: number;   // only for 'change'
    seq: number;
}

export interface ChangeMessage {
    type: 'change';
    path: string;
    content: string; // base64
    mtime: number;
    seq: number;
    deviceId?: string;
}

export interface DeleteMessage {
    type: 'delete';
    path: string;
    seq: number;
    deviceId?: string;
}

export interface ConflictMessage {
    type: 'conflict';
    path: string;
    serverContent: string; // base64
    serverMtime: number;
    serverSeq: number;
}

export interface ErrorMessage {
    type: 'error';
    message: string;
}

export type IncomingMessage = SyncResponse | ChangeMessage | DeleteMessage | ConflictMessage | ErrorMessage;

// Plugin settings
export interface VaultSyncSettings {
    serverUrl: string;
    authToken: string;
    deviceId: string;
    enabled: boolean;
    debounceMs: number;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
    serverUrl: '',
    authToken: '',
    deviceId: '',
    enabled: false,
    debounceMs: 500,
};

// Local state
export interface SyncState {
    lastSeq: number;
    localHashes: Map<string, string>;
}

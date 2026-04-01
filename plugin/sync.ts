import { App, TFile, TAbstractFile, normalizePath } from 'obsidian';
import {
    VaultSyncSettings,
    SyncState,
    SyncRequest,
    FileChangeRequest,
    FileDeleteRequest,
    IncomingMessage,
    MSG_TYPE_SYNC,
    MSG_TYPE_FILE_CHANGE,
    MSG_TYPE_FILE_DELETE,
    MSG_TYPE_SYNC_RESPONSE,
    MSG_TYPE_CHANGE,
    MSG_TYPE_DELETE,
    MSG_TYPE_CONFLICT,
    MSG_TYPE_ERROR,
} from './types';

export class SyncClient {
    private app: App;
    private settings: VaultSyncSettings;
    private ws: WebSocket | null = null;
    private state: SyncState;
    private reconnectTimeout: number | null = null;
    private pendingChanges: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private processingRemote: Set<string> = new Set();
    private statusCallback: (status: string) => void;

    constructor(app: App, settings: VaultSyncSettings, statusCallback: (status: string) => void) {
        this.app = app;
        this.settings = settings;
        this.statusCallback = statusCallback;
        this.state = {
            lastSeq: 0,
            localHashes: new Map(),
        };
        this.loadState();
    }

    // Connect to server
    async connect(): Promise<void> {
        if (!this.settings.enabled || !this.settings.serverUrl || !this.settings.authToken) {
            return;
        }

        if (this.ws?.readyState === WebSocket.OPEN) {
            return;
        }

        const url = new URL(this.settings.serverUrl);
        url.pathname = '/ws';
        url.searchParams.set('token', this.settings.authToken);
        url.searchParams.set('device', this.settings.deviceId);

        const wsUrl = url.toString().replace('http', 'ws');
        console.log('[VaultSync] Connecting to:', wsUrl.replace(/token=[^&]+/, 'token=***'));

        try {
            this.ws = new WebSocket(wsUrl);
            this.ws.onopen = () => this.onOpen();
            this.ws.onmessage = (e) => this.onMessage(e);
            this.ws.onclose = (e) => this.onClose(e);
            this.ws.onerror = (e) => this.onError(e);
        } catch (err) {
            console.error('[VaultSync] Connection error:', err);
            this.scheduleReconnect();
        }
    }

    // Disconnect from server
    disconnect(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.statusCallback('disconnected');
    }

    // Handle local file modification
    async onFileModify(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (this.processingRemote.has(file.path)) return;
        if (file.path.startsWith('.')) return;

        // Debounce
        const existing = this.pendingChanges.get(file.path);
        if (existing) clearTimeout(existing);

        this.pendingChanges.set(file.path, setTimeout(async () => {
            this.pendingChanges.delete(file.path);
            await this.sendFileChange(file);
        }, this.settings.debounceMs));
    }

    // Handle local file creation
    async onFileCreate(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (this.processingRemote.has(file.path)) return;
        if (file.path.startsWith('.')) return;

        await this.sendFileChange(file);
    }

    // Handle local file deletion
    async onFileDelete(file: TAbstractFile): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (this.processingRemote.has(file.path)) return;
        if (file.path.startsWith('.')) return;

        this.state.localHashes.delete(file.path);
        this.sendFileDelete(file.path);
    }

    // Handle local file rename
    async onFileRename(file: TAbstractFile, oldPath: string): Promise<void> {
        if (!(file instanceof TFile)) return;
        if (file.path.startsWith('.')) return;

        // Delete old path
        this.state.localHashes.delete(oldPath);
        this.sendFileDelete(oldPath);

        // Create new path
        await this.sendFileChange(file);
    }

    private onOpen(): void {
        console.log('[VaultSync] Connected');
        this.statusCallback('connected');
        this.requestSync();
    }

    private onClose(event: CloseEvent): void {
        console.log('[VaultSync] Disconnected:', event.code, event.reason);
        this.statusCallback('disconnected');
        this.scheduleReconnect();
    }

    private onError(event: Event): void {
        console.error('[VaultSync] WebSocket error:', event);
    }

    private async onMessage(event: MessageEvent): Promise<void> {
        try {
            const msg: IncomingMessage = JSON.parse(event.data);

            switch (msg.type) {
                case MSG_TYPE_SYNC_RESPONSE:
                    await this.handleSyncResponse(msg);
                    break;
                case MSG_TYPE_CHANGE:
                    await this.handleChange(msg);
                    break;
                case MSG_TYPE_DELETE:
                    await this.handleDelete(msg);
                    break;
                case MSG_TYPE_CONFLICT:
                    await this.handleConflict(msg);
                    break;
                case MSG_TYPE_ERROR:
                    console.error('[VaultSync] Server error:', msg.message);
                    break;
            }
        } catch (err) {
            console.error('[VaultSync] Error processing message:', err);
        }
    }

    private requestSync(): void {
        const msg: SyncRequest = {
            type: MSG_TYPE_SYNC,
            lastSeq: this.state.lastSeq,
        };
        this.send(msg);
        console.log('[VaultSync] Requested sync from seq:', this.state.lastSeq);
    }

    private async handleSyncResponse(msg: { currentSeq: number; changes: Array<{ type: string; path: string; content?: string; mtime?: number; seq: number }> }): Promise<void> {
        console.log('[VaultSync] Sync response: seq=', msg.currentSeq, 'changes=', msg.changes.length);

        let applied = 0;
        let skipped = 0;
        let errors = 0;

        for (const change of msg.changes) {
            try {
                if (change.type === 'change' && change.content) {
                    await this.applyRemoteChange(change.path, change.content, change.mtime || Date.now());
                    applied++;
                } else if (change.type === 'delete') {
                    await this.applyRemoteDelete(change.path);
                    applied++;
                } else {
                    skipped++;
                }
            } catch (err) {
                errors++;
                console.error('[VaultSync] Error processing change:', change.path, err);
            }
        }

        console.log(`[VaultSync] Sync complete: applied=${applied}, skipped=${skipped}, errors=${errors}`);

        this.state.lastSeq = msg.currentSeq;
        this.saveState();

        // После получения изменений с сервера - отправить локальные файлы
        await this.syncLocalFiles();

        this.statusCallback('synced');
    }

    private async syncLocalFiles(): Promise<void> {
        console.log('[VaultSync] Scanning local files...');
        const files = this.app.vault.getFiles();

        for (const file of files) {
            if (file.path.startsWith('.')) continue;

            try {
                // sendFileChange сам проверит hash и отправит если нужно
                await this.sendFileChange(file);
            } catch (err) {
                console.error('[VaultSync] Error syncing local file:', file.path, err);
            }
        }

        console.log('[VaultSync] Local sync complete');
    }

    private async handleChange(msg: { path: string; content: string; mtime: number; seq: number; deviceId?: string }): Promise<void> {
        // Skip if from this device
        if (msg.deviceId === this.settings.deviceId) return;

        console.log('[VaultSync] Remote change:', msg.path, 'seq=', msg.seq);
        await this.applyRemoteChange(msg.path, msg.content, msg.mtime);

        if (msg.seq > this.state.lastSeq) {
            this.state.lastSeq = msg.seq;
            this.saveState();
        }
    }

    private async handleDelete(msg: { path: string; seq: number; deviceId?: string }): Promise<void> {
        // Skip if from this device
        if (msg.deviceId === this.settings.deviceId) return;

        console.log('[VaultSync] Remote delete:', msg.path, 'seq=', msg.seq);
        await this.applyRemoteDelete(msg.path);

        if (msg.seq > this.state.lastSeq) {
            this.state.lastSeq = msg.seq;
            this.saveState();
        }
    }

    private async handleConflict(msg: { path: string; serverContent: string; serverMtime: number; serverSeq: number }): Promise<void> {
        console.log('[VaultSync] Conflict on:', msg.path, '- accepting server version');
        await this.applyRemoteChange(msg.path, msg.serverContent, msg.serverMtime);

        if (msg.serverSeq > this.state.lastSeq) {
            this.state.lastSeq = msg.serverSeq;
            this.saveState();
        }
    }

    private async applyRemoteChange(path: string, contentBase64: string, mtime: number): Promise<void> {
        this.processingRemote.add(path);

        try {
            const content = this.base64Decode(contentBase64);
            const hash = await this.computeHash(content);

            // Check if we already have this version
            const existingHash = this.state.localHashes.get(path);
            if (existingHash === hash) {
                console.log('[VaultSync] Skipping (same hash):', path);
                return;
            }

            const normalizedPath = normalizePath(path);
            const file = this.app.vault.getAbstractFileByPath(normalizedPath);

            if (file instanceof TFile) {
                await this.app.vault.modify(file, content);
            } else {
                // Create directories if needed
                const dir = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
                if (dir) {
                    await this.ensureDirectory(dir);
                }
                await this.app.vault.create(normalizedPath, content);
            }

            this.state.localHashes.set(path, hash);
            console.log('[VaultSync] Applied remote change:', path);
        } catch (err) {
            console.error('[VaultSync] Error applying change to', path, ':', err);
        } finally {
            // Delay removing from processingRemote to avoid triggering local events
            setTimeout(() => {
                this.processingRemote.delete(path);
            }, 100);
        }
    }

    private async applyRemoteDelete(path: string): Promise<void> {
        this.processingRemote.add(path);

        try {
            const normalizedPath = normalizePath(path);
            const file = this.app.vault.getAbstractFileByPath(normalizedPath);

            if (file instanceof TFile) {
                await this.app.vault.delete(file);
                console.log('[VaultSync] Applied remote delete:', path);
            }

            this.state.localHashes.delete(path);
        } catch (err) {
            console.error('[VaultSync] Error applying delete to', path, ':', err);
        } finally {
            setTimeout(() => {
                this.processingRemote.delete(path);
            }, 100);
        }
    }

    private async sendFileChange(file: TFile): Promise<void> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        try {
            const content = await this.app.vault.read(file);
            const hash = await this.computeHash(content);

            // Skip if unchanged
            if (this.state.localHashes.get(file.path) === hash) {
                return;
            }

            const msg: FileChangeRequest = {
                type: MSG_TYPE_FILE_CHANGE,
                path: file.path,
                content: this.base64Encode(content),
                mtime: file.stat.mtime,
                hash: hash,
            };

            this.send(msg);
            this.state.localHashes.set(file.path, hash);
            console.log('[VaultSync] Sent change:', file.path);
        } catch (err) {
            console.error('[VaultSync] Error sending change:', err);
        }
    }

    private sendFileDelete(path: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const msg: FileDeleteRequest = {
            type: MSG_TYPE_FILE_DELETE,
            path: path,
        };

        this.send(msg);
        console.log('[VaultSync] Sent delete:', path);
    }

    private send(msg: object): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimeout) return;
        if (!this.settings.enabled) return;

        this.reconnectTimeout = window.setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect();
        }, 5000);
    }

    private async ensureDirectory(path: string): Promise<void> {
        const parts = path.split('/');
        let current = '';

        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            const folder = this.app.vault.getAbstractFileByPath(current);
            if (!folder) {
                await this.app.vault.createFolder(current);
            }
        }
    }

    private base64Encode(str: string): string {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(str);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    private base64Decode(base64: string): string {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        const decoder = new TextDecoder();
        return decoder.decode(bytes);
    }

    private async computeHash(content: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(content);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    private loadState(): void {
        try {
            const data = localStorage.getItem(`vault-sync-state-${this.settings.deviceId}`);
            if (data) {
                const parsed = JSON.parse(data);
                this.state.lastSeq = parsed.lastSeq || 0;
                this.state.localHashes = new Map(Object.entries(parsed.localHashes || {}));
            }
        } catch (err) {
            console.error('[VaultSync] Error loading state:', err);
        }
    }

    private saveState(): void {
        try {
            const data = {
                lastSeq: this.state.lastSeq,
                localHashes: Object.fromEntries(this.state.localHashes),
            };
            localStorage.setItem(`vault-sync-state-${this.settings.deviceId}`, JSON.stringify(data));
        } catch (err) {
            console.error('[VaultSync] Error saving state:', err);
        }
    }

    // Full resync - reset state and sync from scratch
    async fullResync(): Promise<void> {
        this.state.lastSeq = 0;
        this.state.localHashes.clear();
        this.saveState();

        if (this.ws?.readyState === WebSocket.OPEN) {
            this.requestSync();
        }
    }
}

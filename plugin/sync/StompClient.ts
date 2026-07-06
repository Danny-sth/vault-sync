import { Client, IMessage, StompSubscription } from '@stomp/stompjs';
import {
  ServerMessage,
  SyncRequest,
  SyncResponse,
  ConnectionState
} from '../types';

export type MessageHandler = (message: ServerMessage) => void;
export type ConnectionHandler = (state: ConnectionState) => void;

interface PendingRequest {
  resolve: (response: SyncResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface StompClientOptions {
  /** Delay before stompjs auto-reconnects a dropped socket. */
  reconnectDelayMs: number;
  /** STOMP heartbeat interval, both directions. */
  heartbeatIntervalMs: number;
  /** How long requestSync waits for the server's response frame. */
  syncTimeoutMs: number;
  /** How long connect() waits before rejecting an unreachable server. */
  connectTimeoutMs: number;
}

const DEFAULT_OPTIONS: StompClientOptions = {
  reconnectDelayMs: 10000,
  heartbeatIntervalMs: 60000,
  syncTimeoutMs: 120000,
  connectTimeoutMs: 20000,
};

export class StompClient {
  private client: Client | null = null;
  private subscriptions: StompSubscription[] = [];
  private messageHandler: MessageHandler | null = null;
  private connectionHandler: ConnectionHandler | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private readonly options: StompClientOptions;

  private serverUrl: string = '';
  private token: string = '';
  private deviceId: string = '';

  constructor(options: Partial<StompClientOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  setConnectionHandler(handler: ConnectionHandler): void {
    this.connectionHandler = handler;
  }

  async connect(serverUrl: string, token: string, deviceId: string): Promise<void> {
    // One live Client at a time. Without this, every connect() while the server was
    // unreachable leaked a previous Client whose reconnectDelay kept it retrying
    // forever — when the server came back, N sockets all subscribed and every
    // broadcast was processed N times.
    if (this.client) {
      void this.client.deactivate();
      this.client = null;
      this.subscriptions = [];
    }

    this.serverUrl = serverUrl;
    this.token = token;
    this.deviceId = deviceId;

    return new Promise((resolve, reject) => {
      this.connectionHandler?.('connecting');

      // connect() must SETTLE even when the server is down — an unsettled promise
      // left connectionState at 'connecting' forever and blocked all reconnects.
      // stompjs keeps auto-reconnecting in the background after this rejection;
      // onConnect still fires later and recovers the session.
      let settled = false;
      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Connect timeout after ${this.options.connectTimeoutMs}ms`));
      }, this.options.connectTimeoutMs);

      this.client = new Client({
        brokerURL: serverUrl,
        connectHeaders: {
          'X-Auth-Token': token,
          'X-Device-Id': deviceId,
        },

        webSocketFactory: () => new WebSocket(serverUrl),

        reconnectDelay: this.options.reconnectDelayMs,
        heartbeatIncoming: this.options.heartbeatIntervalMs,
        heartbeatOutgoing: this.options.heartbeatIntervalMs,

        onConnect: () => {
          // Fires on the FIRST connect and on every silent stompjs auto-reconnect;
          // subscriptions died with the old socket, so they are re-created each time.
          this.subscriptions = [];
          this.setupSubscriptions();
          this.connectionHandler?.('connected');
          if (!settled) {
            settled = true;
            clearTimeout(connectTimer);
            resolve();
          }
        },

        onStompError: (frame) => {
          console.error('[VaultSync] STOMP error:', frame.headers['message']);
          this.connectionHandler?.('error');
          if (!settled) {
            settled = true;
            clearTimeout(connectTimer);
            reject(new Error(frame.headers['message'] || 'STOMP connection error'));
          }
        },

        onWebSocketError: (event) => {
          console.error('[VaultSync] WebSocket error:', event);
          this.connectionHandler?.('error');
        },

        onDisconnect: () => {
          this.connectionHandler?.('disconnected');
        },

        onWebSocketClose: () => {
          this.connectionHandler?.('disconnected');
        },
      });

      this.client.activate();
    });
  }

  private setupSubscriptions(): void {
    if (!this.client || !this.client.connected) return;

    const broadcastSub = this.client.subscribe('/topic/sync', (message: IMessage) => {
      try {
        const data = JSON.parse(message.body) as ServerMessage;

        if ('deviceId' in data && data.deviceId === this.deviceId) {
          return;
        }

        this.messageHandler?.(data);
      } catch (e) {
        console.error('[VaultSync] Failed to parse message:', e);
      }
    });
    this.subscriptions.push(broadcastSub);

    const syncSub = this.client.subscribe('/user/queue/sync', (message: IMessage) => {
      console.debug('[VaultSync] Received sync response message');
      try {
        const data = JSON.parse(message.body) as SyncResponse;
        console.debug(`[VaultSync] Parsed: ${data.files?.length || 0} files, seq=${data.currentSeq}, requestId=${data.requestId}`);

        if (data.requestId && this.pendingRequests.has(data.requestId)) {
          const pending = this.pendingRequests.get(data.requestId)!;
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(data.requestId);
          pending.resolve(data);
          console.debug(`[VaultSync] Resolved request ${data.requestId}`);
        } else {
          console.warn('[VaultSync] Received response with unknown requestId:', data.requestId);
        }
      } catch (e) {
        console.error('[VaultSync] Failed to parse sync response:', e);
      }
    });
    this.subscriptions.push(syncSub);

  }

  disconnect(): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Disconnected'));
      console.debug(`[VaultSync] Cancelled pending request ${requestId} due to disconnect`);
    }
    this.pendingRequests.clear();

    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];

    if (this.client) {
      const dying = this.client;
      this.client = null;
      // Neutralise the callbacks BEFORE deactivating: deactivate() is async, and a
      // client mid-handshake can still fire onConnect afterwards. On a plugin reload
      // that zombie resurrected the OLD SyncManager (closed IndexedDB) and spammed
      // "Database not initialized" / "unknown requestId" errors.
      dying.onConnect = () => {};
      dying.onDisconnect = () => {};
      dying.onStompError = () => {};
      dying.onWebSocketError = () => {};
      dying.onWebSocketClose = () => {};
      void dying.deactivate();
    }

    this.connectionHandler?.('disconnected');
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  requestSync(lastSeq: number): Promise<SyncResponse> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error('Not connected'));
        return;
      }

      const requestId = this.generateRequestId();

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Sync request timeout'));
      }, this.options.syncTimeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      this.client!.publish({
        destination: '/app/sync.request',
        body: JSON.stringify({
          requestId,
          lastSeq,
          deviceId: this.deviceId,
        } as SyncRequest),
      });

      console.debug(`[VaultSync] Sent sync request ${requestId} (lastSeq=${lastSeq})`);
    });
  }

  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }
}

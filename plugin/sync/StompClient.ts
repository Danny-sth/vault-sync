import { Client, IMessage, StompSubscription } from '@stomp/stompjs';
import {
  ServerMessage,
  FileChangeRequest,
  FileDeleteRequest,
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

export class StompClient {
  private client: Client | null = null;
  private subscriptions: StompSubscription[] = [];
  private messageHandler: MessageHandler | null = null;
  private connectionHandler: ConnectionHandler | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();

  private serverUrl: string = '';
  private token: string = '';
  private deviceId: string = '';

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  setConnectionHandler(handler: ConnectionHandler): void {
    this.connectionHandler = handler;
  }

  async connect(serverUrl: string, token: string, deviceId: string): Promise<void> {
    this.serverUrl = serverUrl;
    this.token = token;
    this.deviceId = deviceId;

    return new Promise((resolve, reject) => {
      this.connectionHandler?.('connecting');

      this.client = new Client({
        brokerURL: serverUrl,
        connectHeaders: {
          'X-Auth-Token': token,
          'X-Device-Id': deviceId,
        },

        webSocketFactory: () => new WebSocket(serverUrl),

        reconnectDelay: 10000,
        heartbeatIncoming: 60000,
        heartbeatOutgoing: 60000,

        onConnect: () => {
          this.connectionHandler?.('connected');
          this.setupSubscriptions();
          resolve();
        },

        onStompError: (frame) => {
          console.error('[VaultSync] STOMP error:', frame.headers['message']);
          this.connectionHandler?.('error');
          reject(new Error(frame.headers['message'] || 'STOMP connection error'));
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

    const pongSub = this.client.subscribe('/user/queue/pong', () => {
    });
    this.subscriptions.push(pongSub);
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
      this.client.deactivate();
      this.client = null;
    }

    this.connectionHandler?.('disconnected');
  }

  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  sendFileChange(request: FileChangeRequest): void {
    if (!this.isConnected()) {
      console.warn('[VaultSync] Cannot send file change - not connected');
      return;
    }

    this.client!.publish({
      destination: '/app/file.change',
      body: JSON.stringify(request),
    });
  }

  sendFileDelete(request: FileDeleteRequest): void {
    if (!this.isConnected()) {
      console.warn('[VaultSync] Cannot send file delete - not connected');
      return;
    }

    this.client!.publish({
      destination: '/app/file.delete',
      body: JSON.stringify(request),
    });
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
      }, 120000);

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

  sendPing(): void {
    if (!this.isConnected()) return;

    this.client!.publish({
      destination: '/app/ping',
      body: '',
    });
  }
}

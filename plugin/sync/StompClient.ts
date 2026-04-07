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

export class StompClient {
  private client: Client | null = null;
  private subscriptions: StompSubscription[] = [];
  private messageHandler: MessageHandler | null = null;
  private connectionHandler: ConnectionHandler | null = null;
  private syncResponseHandler: ((response: SyncResponse) => void) | null = null;

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

        reconnectDelay: 5000,
        heartbeatIncoming: 10000,
        heartbeatOutgoing: 10000,

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

    // Subscribe to broadcast channel
    const broadcastSub = this.client.subscribe('/topic/sync', (message: IMessage) => {
      try {
        const data = JSON.parse(message.body) as ServerMessage;

        // Skip messages from this device
        if ('deviceId' in data && data.deviceId === this.deviceId) {
          return;
        }

        this.messageHandler?.(data);
      } catch (e) {
        console.error('[VaultSync] Failed to parse message:', e);
      }
    });
    this.subscriptions.push(broadcastSub);

    // Subscribe to private sync response queue
    const syncSub = this.client.subscribe('/user/queue/sync', (message: IMessage) => {
      console.debug('[VaultSync] *** Received sync response message ***');
      try {
        const data = JSON.parse(message.body) as SyncResponse;
        console.debug(`[VaultSync] *** Parsed: ${data.files?.length || 0} files, seq=${data.currentSeq} ***`);
        if (this.syncResponseHandler) {
          console.debug('[VaultSync] *** Calling syncResponseHandler ***');
          this.syncResponseHandler(data);
          console.debug('[VaultSync] *** syncResponseHandler called ***');
        } else {
          console.error('[VaultSync] *** ERROR: No syncResponseHandler set! ***');
        }
      } catch (e) {
        console.error('[VaultSync] *** Failed to parse sync response:', e);
      }
    });
    this.subscriptions.push(syncSub);

    // Subscribe to pong for heartbeat
    const pongSub = this.client.subscribe('/user/queue/pong', () => {
      // Heartbeat received
    });
    this.subscriptions.push(pongSub);
  }

  disconnect(): void {
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

      // Set up one-time response handler
      const timeout = setTimeout(() => {
        this.syncResponseHandler = null;
        reject(new Error('Sync request timeout'));
      }, 30000);

      this.syncResponseHandler = (response: SyncResponse) => {
        clearTimeout(timeout);
        this.syncResponseHandler = null;
        resolve(response);
      };

      // Send sync request
      this.client!.publish({
        destination: '/app/sync.request',
        body: JSON.stringify({
          lastSeq,
          deviceId: this.deviceId,
        } as SyncRequest),
      });
    });
  }

  sendPing(): void {
    if (!this.isConnected()) return;

    this.client!.publish({
      destination: '/app/ping',
      body: '',
    });
  }
}

import { WebSocketServer as WsServer, type WebSocket } from 'ws';
import { ClientConnection } from './ClientConnection.js';
import type { Config } from '../config.js';
import type { ClientMessage, SessionInfo, SessionScreen } from '../types/protocol.js';

export interface SessionProvider {
  listSessions(): SessionInfo[];
  getDefaultSessionId(): string | null;
  getLatestSnapshot(sessionId: string): SessionScreen | null;
}

export class WebSocketServer {
  private wss: WsServer | null = null;
  private clients = new Map<string, ClientConnection>();

  constructor(
    private readonly config: Config,
    private sessionProvider: SessionProvider,
  ) {}

  start(): void {
    this.wss = new WsServer({ port: this.config.port });
    console.log(`[ws] Listening on port ${this.config.port}`);

    this.wss.on('connection', (ws: WebSocket) => {
      const client = new ClientConnection(ws);
      this.clients.set(client.id, client);
      console.log(`[ws] Client connected: ${client.id}`);

      ws.on('message', (data: Buffer) => {
        this.handleMessage(client, data);
      });

      ws.on('close', () => {
        this.clients.delete(client.id);
        console.log(`[ws] Client disconnected: ${client.id}`);
      });

      ws.on('error', (err: Error) => {
        console.error(`[ws] Client error ${client.id}:`, err.message);
      });
    });
  }

  private handleMessage(client: ClientConnection, data: Buffer): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      client.sendError('INVALID_JSON', 'Message is not valid JSON');
      return;
    }

    if (!msg.type) {
      client.sendError('MISSING_TYPE', 'Message missing "type" field');
      return;
    }

    // Before auth, only client.hello is allowed
    if (!client.authenticated) {
      if (msg.type !== 'client.hello') {
        client.sendError('NOT_AUTHENTICATED', 'Send client.hello first');
        return;
      }
      this.handleHello(client, msg);
      return;
    }

    switch (msg.type) {
      case 'session.list':
        this.handleSessionList(client);
        break;
      case 'session.switch':
        this.handleSessionSwitch(client, msg.sessionId);
        break;
      case 'client.grid':
        client.updateGrid(msg.cols, msg.rows);
        break;
      default:
        client.sendError('UNKNOWN_TYPE', `Unknown message type: ${(msg as any).type}`);
    }
  }

  private handleHello(client: ClientConnection, msg: ClientMessage & { type: 'client.hello' }): void {
    if (msg.token !== this.config.token) {
      client.sendError('AUTH_FAILED', 'Invalid token');
      client.ws.close(4003, 'Auth failed');
      return;
    }

    const cols = msg.grid?.cols || this.config.defaultCols;
    const rows = msg.grid?.rows || this.config.defaultRows;
    client.markAuthenticated(cols, rows);

    const sessions = this.sessionProvider.listSessions();
    const activeSessionId = this.sessionProvider.getDefaultSessionId() || sessions[0]?.id || '';
    client.activeSessionId = activeSessionId;

    client.send({
      type: 'hello.ok',
      sessions,
      activeSessionId,
    });

    // Send latest snapshot if available
    if (activeSessionId) {
      const snapshot = this.sessionProvider.getLatestSnapshot(activeSessionId);
      if (snapshot) {
        client.send(snapshot);
      }
    }

    console.log(`[ws] Client authenticated: ${client.id} (${cols}x${rows})`);
  }

  private handleSessionList(client: ClientConnection): void {
    client.send({
      type: 'session.list.result',
      sessions: this.sessionProvider.listSessions(),
    });
  }

  private handleSessionSwitch(client: ClientConnection, sessionId: string): void {
    const sessions = this.sessionProvider.listSessions();
    const found = sessions.find(s => s.id === sessionId);
    if (!found) {
      client.sendError('SESSION_NOT_FOUND', `No session with id: ${sessionId}`);
      return;
    }

    client.activeSessionId = sessionId;
    client.send({ type: 'session.switched', sessionId });

    // Send latest snapshot for the new session
    const snapshot = this.sessionProvider.getLatestSnapshot(sessionId);
    if (snapshot) {
      client.send(snapshot);
    }
  }

  /** Broadcast a snapshot to all authenticated clients viewing the given session. */
  broadcastSnapshot(snapshot: SessionScreen): void {
    for (const client of this.clients.values()) {
      if (client.authenticated && client.activeSessionId === snapshot.sessionId) {
        client.send(snapshot);
      }
    }
  }

  /** Get all authenticated clients viewing a given session. */
  getClientsForSession(sessionId: string): ClientConnection[] {
    return Array.from(this.clients.values()).filter(
      c => c.authenticated && c.activeSessionId === sessionId,
    );
  }

  stop(): void {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
    console.log('[ws] Server stopped');
  }
}

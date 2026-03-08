import { WebSocketServer as WsServer, type WebSocket } from 'ws';
import { ClientConnection } from './ClientConnection.js';
import { RoleManager } from './RoleManager.js';
import type { Config } from '../config.js';
import type { ClientMessage, SessionInfo, SessionScreen, Transcript } from '../types/protocol.js';
import type { CommandClassifier } from '../classify/CommandClassifier.js';
import type { SttBridge } from '../stt/SttBridge.js';

export interface SessionProvider {
  listSessions(): SessionInfo[];
  getDefaultSessionId(): string | null;
  getLatestSnapshot(sessionId: string): SessionScreen | null;
  writeInput(sessionId: string, text: string): void;
  writeRaw(sessionId: string, data: string): void;
  sendSignal(sessionId: string, signal: 'SIGINT' | 'SIGKILL'): void;
}

export class WebSocketServer {
  private wss: WsServer | null = null;
  private clients = new Map<string, ClientConnection>();
  private roleManager = new RoleManager();

  private sttBridge: SttBridge | null = null;
  private classifier: CommandClassifier | null = null;

  constructor(
    private readonly config: Config,
    private sessionProvider: SessionProvider,
  ) {}

  setSttBridge(bridge: SttBridge): void {
    this.sttBridge = bridge;
  }

  setClassifier(classifier: CommandClassifier): void {
    this.classifier = classifier;
  }

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
        this.handleDisconnect(client);
      });

      ws.on('error', (err: Error) => {
        console.error(`[ws] Client error ${client.id}:`, err.message);
      });
    });
  }

  private handleDisconnect(client: ClientConnection): void {
    // Clean up audio stream
    client.clearAudioTimeout();
    if (client.audioStream) {
      client.audioStream.end();
      client.audioStream = null;
    }

    this.clients.delete(client.id);

    if (client.authenticated) {
      // Handle role transfer on disconnect
      const promoted = this.roleManager.removeClient(client.id);

      // Broadcast client.left to remaining clients
      this.broadcast({
        type: 'client.left',
        clientId: client.id,
      });

      // Notify promoted client
      if (promoted) {
        promoted.send({
          type: 'role.granted',
          role: 'operator',
          roleVersion: this.roleManager.roleVersion,
        });
      }
    }

    console.log(`[ws] Client disconnected: ${client.id}`);
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
      case 'session.input':
        if (!this.requireOperator(client)) return;
        this.handleSessionInput(client, msg.sessionId, msg.text, msg.source);
        break;
      case 'session.signal':
        if (!this.requireOperator(client)) return;
        this.handleSessionSignal(client, msg.sessionId, msg.signal);
        break;
      case 'input.confirm':
        if (!this.requireOperator(client)) return;
        this.handleInputConfirm(client, msg.transcriptSeq, msg.action);
        break;
      case 'audio.stream.start':
        if (!this.requireOperator(client)) return;
        this.handleAudioStreamStart(client, msg.sessionId, msg.sampleRate, msg.encoding);
        break;
      case 'audio.chunk':
        if (!this.requireOperator(client)) return;
        this.handleAudioChunk(client, msg.data, msg.seq);
        break;
      case 'audio.stream.end':
        if (!this.requireOperator(client)) return;
        this.handleAudioStreamEnd(client);
        break;
      case 'role.claim':
        this.handleRoleClaim(client, msg.force);
        break;
      case 'session.raw':
        if (!this.requireOperator(client)) return;
        this.handleSessionRaw(client, msg.sessionId, msg.data);
        break;
      default:
        client.sendError('UNKNOWN_TYPE', `Unknown message type: ${(msg as any).type}`);
    }
  }

  /** Returns true if client is operator. Sends NOT_OPERATOR error if not. */
  private requireOperator(client: ClientConnection): boolean {
    if (this.roleManager.isOperator(client.id)) return true;
    client.sendError('NOT_OPERATOR', 'Only the operator can perform this action');
    return false;
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

    // Set device type (default 'glasses' for backward compat with Phase 1 clients)
    client.deviceType = msg.deviceType || 'glasses';

    // Assign role
    const role = this.roleManager.addClient(client);

    const sessions = this.sessionProvider.listSessions();
    const activeSessionId = this.sessionProvider.getDefaultSessionId() || sessions[0]?.id || '';
    client.activeSessionId = activeSessionId;

    client.send({
      type: 'hello.ok',
      sessions,
      activeSessionId,
      role,
      clients: this.roleManager.getClientInfos(),
      roleVersion: this.roleManager.roleVersion,
    });

    // Send latest snapshot if available
    if (activeSessionId) {
      const snapshot = this.sessionProvider.getLatestSnapshot(activeSessionId);
      if (snapshot) {
        client.send(snapshot);
      }
    }

    // Broadcast client.joined to other clients
    this.broadcastExcept(client.id, {
      type: 'client.joined',
      clientId: client.id,
      deviceType: client.deviceType,
      role,
    });

    console.log(`[ws] Client authenticated: ${client.id} (${cols}x${rows}, ${client.deviceType}, ${role})`);
  }

  private handleRoleClaim(client: ClientConnection, force: boolean): void {
    const previousOperator = this.roleManager.getAllClients().find(c => c.role === 'operator');
    const success = this.roleManager.claimOperator(client, force);

    if (!success) {
      client.sendError('ROLE_DENIED', 'Cannot claim operator role without force');
      return;
    }

    // Notify the new operator
    client.send({
      type: 'role.granted',
      role: 'operator',
      roleVersion: this.roleManager.roleVersion,
    });

    // Notify the previous operator they were demoted
    if (previousOperator && previousOperator.id !== client.id) {
      // Clean up any active audio stream from the demoted operator
      this.cleanupAudioStream(previousOperator);

      previousOperator.send({
        type: 'role.revoked',
        newRole: 'viewer',
        reason: force ? 'force_claim' : (client.deviceType === 'phone' ? 'phone_priority' : 'claim'),
        roleVersion: this.roleManager.roleVersion,
      });
    }
  }

  /** Clean up audio stream for a client (used when role is revoked). */
  private cleanupAudioStream(client: ClientConnection): void {
    client.clearAudioTimeout();
    if (client.audioStream) {
      client.audioStream.end();
      client.audioStream = null;
      client.audioSessionId = null;
      client.send({ type: 'audio.stream.closed', reason: 'end' });
    }
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

  private handleSessionInput(
    client: ClientConnection,
    sessionId: string,
    text: string,
    source: 'voice' | 'keyboard',
  ): void {
    try {
      this.sessionProvider.writeInput(sessionId, text);
      client.send({
        type: 'input.accepted',
        sessionId,
        text,
        source,
      });
      console.log(`[ws] Input to session ${sessionId}: ${text.substring(0, 80)}`);
    } catch (e: any) {
      client.sendError('SESSION_ERROR', e.message);
    }
  }

  private handleSessionSignal(
    client: ClientConnection,
    sessionId: string,
    signal: 'SIGINT' | 'SIGKILL',
  ): void {
    try {
      this.sessionProvider.sendSignal(sessionId, signal);
      console.log(`[ws] Signal ${signal} to session ${sessionId}`);
    } catch (e: any) {
      client.sendError('SESSION_ERROR', e.message);
    }
  }

  private handleInputConfirm(
    client: ClientConnection,
    transcriptSeq: number,
    action: 'send' | 'cancel',
  ): void {
    const pending = client.pendingTranscript;
    if (!pending || pending.seq !== transcriptSeq) {
      client.sendError('NO_PENDING', 'No matching pending transcript');
      return;
    }

    client.pendingTranscript = null;

    if (action === 'send') {
      try {
        this.sessionProvider.writeInput(pending.sessionId, pending.text);
        client.send({
          type: 'input.accepted',
          sessionId: pending.sessionId,
          text: pending.text,
          source: 'voice',
        });
        console.log(`[ws] Confirmed input to session ${pending.sessionId}: ${pending.text.substring(0, 80)}`);
      } catch (e: any) {
        client.sendError('SESSION_ERROR', e.message);
      }
    } else {
      console.log(`[ws] Cancelled input: ${pending.text.substring(0, 80)}`);
    }
  }

  private handleSessionRaw(client: ClientConnection, sessionId: string, data: string): void {
    try {
      this.sessionProvider.writeRaw(sessionId, data);
      console.log(`[ws] Raw input to session ${sessionId}: ${data.length} chars`);
    } catch (e: any) {
      client.sendError('SESSION_ERROR', e.message);
    }
  }

  private handleAudioStreamStart(
    client: ClientConnection,
    sessionId: string,
    sampleRate: number,
    encoding: string,
  ): void {
    if (!this.sttBridge) {
      client.sendError('STT_UNAVAILABLE', 'STT is not configured');
      return;
    }

    client.audioSessionId = sessionId;

    const onTranscript = (text: string, confidence: number, isFinal: boolean) => {
      // Guard against stale transcripts from revoked operators
      if (!this.roleManager.isOperator(client.id)) return;

      const seq = client.nextTranscriptSeq();
      const classification = this.classifier?.classify(text) ?? 'safe';

      const transcript: Transcript = {
        type: 'transcript',
        text,
        confidence,
        isFinal,
        seq,
        classification,
      };

      client.send(transcript);

      // Store pending transcript for confirm flow, bound to the originating session
      if (isFinal && classification !== 'deny') {
        client.pendingTranscript = { text, seq, sessionId };
      }
    };

    try {
      const stream = this.sttBridge.createStream(sampleRate, encoding, onTranscript);
      client.audioStream = stream;
      client.startAudioTimeout(() => {
        client.clearAudioTimeout();
        if (client.audioStream) {
          client.audioStream.end();
          client.audioStream = null;
          client.audioSessionId = null;
          client.send({ type: 'audio.stream.closed', reason: 'timeout' });
          console.log(`[ws] Audio stream timed out for client ${client.id}`);
        }
      });
      client.send({ type: 'audio.stream.ready' });
      console.log(`[ws] Audio stream started for client ${client.id}`);
    } catch (e: any) {
      client.sendError('STT_ERROR', e.message);
    }
  }

  private handleAudioChunk(client: ClientConnection, data: string, seq: number): void {
    if (!client.audioStream) {
      client.sendError('NO_STREAM', 'No active audio stream');
      return;
    }

    client.resetAudioTimeout();

    try {
      const pcm = Buffer.from(data, 'base64');
      client.audioStream.write(pcm);
    } catch (e: any) {
      client.sendError('AUDIO_ERROR', e.message);
    }
  }

  private handleAudioStreamEnd(client: ClientConnection): void {
    client.clearAudioTimeout();
    if (client.audioStream) {
      client.audioStream.end();
      client.audioStream = null;
      client.audioSessionId = null;
      client.send({ type: 'audio.stream.closed', reason: 'end' });
      console.log(`[ws] Audio stream ended for client ${client.id}`);
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

  /** Broadcast a message to all authenticated clients. */
  private broadcast(message: any): void {
    for (const client of this.clients.values()) {
      if (client.authenticated) {
        client.send(message);
      }
    }
  }

  /** Broadcast a message to all authenticated clients except one. */
  private broadcastExcept(excludeId: string, message: any): void {
    for (const client of this.clients.values()) {
      if (client.authenticated && client.id !== excludeId) {
        client.send(message);
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

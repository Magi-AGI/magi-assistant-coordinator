import { WebSocketServer as WsServer, type WebSocket } from 'ws';
import { ClientConnection } from './ClientConnection.js';
import { RoleManager } from './RoleManager.js';
import { ClientScreenTracker } from '../vtb/ClientScreenTracker.js';
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
  resizeAll(cols: number, rows: number): void;
  clientConnected(clientId: string): void;
  clientDisconnected(clientId: string): void;
  restartSession(sessionId: string): void;
}

export class WebSocketServer {
  private wss: WsServer | null = null;
  private clients = new Map<string, ClientConnection>();
  private roleManager: RoleManager;
  private screenTracker = new ClientScreenTracker();

  private sttBridge: SttBridge | null = null;
  private classifier: CommandClassifier | null = null;

  constructor(
    private readonly config: Config,
    private sessionProvider: SessionProvider,
  ) {
    this.roleManager = new RoleManager(config.graceDisconnectMs);
    this.roleManager.onAutoPromote = (promoted) => {
      promoted.send({
        type: 'role.granted',
        role: 'operator',
        roleVersion: this.roleManager.roleVersion,
      });
      this.resizeToOperator();
    };
  }

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

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          this.handleBinaryMessage(client, data);
        } else {
          this.handleMessage(client, data);
        }
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
    this.screenTracker.resetClient(client.id);

    if (client.authenticated) {
      // Handle role transfer on disconnect (may be deferred by grace timer)
      const promoted = this.roleManager.removeClient(client.id);

      // Broadcast client.left to remaining clients
      this.broadcast({
        type: 'client.left',
        clientId: client.id,
      });

      // Notify promoted client (only when graceMs=0, otherwise handled by onAutoPromote callback)
      if (promoted) {
        promoted.send({
          type: 'role.granted',
          role: 'operator',
          roleVersion: this.roleManager.roleVersion,
        });
        this.resizeToOperator();
      }

      this.sessionProvider.clientDisconnected(client.id);
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
        // Only operator's grid drives PTY resize
        if (this.roleManager.isOperator(client.id)) {
          this.sessionProvider.resizeAll(msg.cols, msg.rows);
        }
        break;
      case 'session.input':
        if (!this.requireOperator(client)) return;
        this.handleSessionInput(client, msg.sessionId, msg.text, msg.source);
        break;
      case 'session.signal':
        if (!this.requireOperatorOrNoOperator(client)) return;
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
      case 'session.resync':
        this.handleSessionResync(client, msg.sessionId);
        break;
      case 'session.restart':
        if (!this.requireOperator(client)) return;
        this.handleSessionRestart(client, msg.sessionId);
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

  /** Returns true if client is operator OR there is no operator (grace period).
   *  Allows emergency signals when operator is disconnected. */
  private requireOperatorOrNoOperator(client: ClientConnection): boolean {
    if (this.roleManager.isOperator(client.id)) return true;
    if (this.roleManager.hasNoOperator()) return true;
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

    // Parse capabilities (Phase 5)
    if (Array.isArray(msg.caps)) {
      for (const cap of msg.caps) {
        if (typeof cap === 'string') client.capabilities.add(cap);
      }
    }

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
        const json = JSON.stringify(snapshot);
        console.log(`[debug:hello] → ${client.id.slice(0,8)} initial snapshot seq=${snapshot.seq} lines=${snapshot.lines.length} json=${json.slice(0,200)}`);
        client.send(snapshot);
      } else {
        console.log(`[debug:hello] → ${client.id.slice(0,8)} no snapshot available`);
      }
    }

    // Broadcast client.joined to other clients
    this.broadcastExcept(client.id, {
      type: 'client.joined',
      clientId: client.id,
      deviceType: client.deviceType,
      role,
    });

    this.sessionProvider.clientConnected(client.id);

    // If this client is operator, resize PTY to their grid
    if (role === 'operator') {
      this.sessionProvider.resizeAll(cols, rows);
    }

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

    // Resize PTY to new operator's grid
    this.resizeToOperator();
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
      client.send({ type: 'signal.accepted', sessionId, signal });
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

  /** Resize all sessions to the current operator's grid dimensions. */
  private resizeToOperator(): void {
    const operator = this.roleManager.getAllClients().find(c => c.role === 'operator');
    if (operator) {
      this.sessionProvider.resizeAll(operator.cols, operator.rows);
    }
  }

  /** Handle binary WebSocket frame: 4-byte BE uint32 seq + raw PCM audio. */
  private handleBinaryMessage(client: ClientConnection, data: Buffer): void {
    if (!client.authenticated) {
      client.sendError('NOT_AUTHENTICATED', 'Send client.hello first');
      return;
    }
    if (!this.requireOperator(client)) return;
    if (!client.audioStream) {
      client.sendError('NO_STREAM', 'No active audio stream');
      return;
    }
    if (data.length < 4) {
      client.sendError('AUDIO_ERROR', 'Binary frame too short');
      return;
    }

    client.resetAudioTimeout();

    try {
      // Skip 4-byte sequence header, rest is raw PCM
      const pcm = data.subarray(4);
      client.audioStream.write(pcm);
    } catch (e: any) {
      client.sendError('AUDIO_ERROR', e.message);
    }
  }

  /** Handle session.resync: clear delta cache and send full frame. */
  private handleSessionResync(client: ClientConnection, sessionId: string): void {
    this.screenTracker.resetSession(client.id, sessionId);
    const snapshot = this.sessionProvider.getLatestSnapshot(sessionId);
    if (snapshot) {
      client.send(snapshot);
    }
  }

  /** Handle session.restart: restart exited session and broadcast. */
  private handleSessionRestart(client: ClientConnection, sessionId: string): void {
    try {
      this.sessionProvider.restartSession(sessionId);

      // Clear delta caches for ALL clients viewing this session to avoid
      // stale baseSeq mismatches after the fresh PTY starts producing output
      for (const c of this.clients.values()) {
        this.screenTracker.resetSession(c.id, sessionId);
      }

      // Resize the restarted session to the current operator's grid
      this.resizeToOperator();

      this.broadcast({
        type: 'session.restarted',
        sessionId,
      });
      console.log(`[ws] Session restarted: ${sessionId}`);
    } catch (e: any) {
      client.sendError('SESSION_ERROR', e.message);
    }
  }

  /** Broadcast session.exited to ALL authenticated clients (global, per Codex #4). */
  broadcastSessionExited(sessionId: string, exitCode: number): void {
    this.broadcast({
      type: 'session.exited',
      sessionId,
      exitCode,
    });
  }

  /**
   * Broadcast a screen update to all authenticated clients viewing the given session.
   * Delta-capable clients get session.screen.delta; others get the full session.screen.
   */
  broadcastScreen(snapshot: SessionScreen): void {
    for (const client of this.clients.values()) {
      if (client.authenticated && client.activeSessionId === snapshot.sessionId) {
        if (client.supportsDelta) {
          const delta = this.screenTracker.computeDelta(
            client.id,
            snapshot.sessionId,
            snapshot.lines,
            snapshot.cursor.row,
            snapshot.cursor.col,
            snapshot.seq,
            snapshot.version,
          );
          if (delta) {
            const changedCount = Object.keys(delta.changedLines).length;
            console.log(`[debug:broadcast] → ${client.id.slice(0,8)} DELTA seq=${delta.seq} baseSeq=${delta.baseSeq} changed=${changedCount}`);
            client.send({
              type: 'session.screen.delta',
              sessionId: delta.sessionId,
              changedLines: delta.changedLines,
              cursorRow: delta.cursorRow,
              cursorCol: delta.cursorCol,
              totalLines: delta.totalLines,
              baseSeq: delta.baseSeq,
              seq: delta.seq,
              version: delta.version,
            });
          } else {
            // No cache (first frame) — send full
            console.log(`[debug:broadcast] → ${client.id.slice(0,8)} FULL seq=${snapshot.seq} lines=${snapshot.lines.length}`);
            client.send(snapshot);
          }
        } else {
          console.log(`[debug:broadcast] → ${client.id.slice(0,8)} FULL (no delta) seq=${snapshot.seq}`);
          client.send(snapshot);
        }
      } else if (client.authenticated) {
        console.log(`[debug:broadcast] SKIP ${client.id.slice(0,8)} activeSession=${client.activeSessionId} snapshot=${snapshot.sessionId}`);
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
    this.roleManager.cancelGrace();
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
    console.log('[ws] Server stopped');
  }
}

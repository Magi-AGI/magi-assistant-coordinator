import { Session } from './Session.js';
import type { Config } from '../config.js';
import type { SessionInfo, SessionScreen } from '../types/protocol.js';
import type { SessionProvider } from '../server/WebSocketServer.js';

export class SessionManager implements SessionProvider {
  private sessions = new Map<string, Session>();
  private _onSnapshot: ((snapshot: SessionScreen) => void) | null = null;
  private _onSessionExit: ((sessionId: string, exitCode: number) => void) | null = null;

  // Track connected authenticated clients by ID (Set avoids drift from mismatched inc/dec)
  private authenticatedClients = new Set<string>();

  // Idle timers for orphaned sessions
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private killTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly config: Config) {}

  set onSnapshot(cb: ((snapshot: SessionScreen) => void) | null) {
    this._onSnapshot = cb;
  }

  set onSessionExit(cb: ((sessionId: string, exitCode: number) => void) | null) {
    this._onSessionExit = cb;
  }

  /** Create and start all sessions from config. */
  startAll(): void {
    for (const sessionConfig of this.config.sessions) {
      if (this.sessions.size >= this.config.maxSessions) {
        console.warn(`[sessions] Max sessions (${this.config.maxSessions}) reached, skipping: ${sessionConfig.id}`);
        break;
      }

      const session = new Session(sessionConfig, this.config);
      session.onSnapshot = (snapshot: SessionScreen) => {
        this._onSnapshot?.(snapshot);
      };
      session.onExit = (sessionId: string, code: number) => {
        // Cancel any pending kill timer for this session
        this.clearKillTimer(sessionId);
        this.clearIdleTimer(sessionId);
        this._onSessionExit?.(sessionId, code);
      };
      this.sessions.set(session.id, session);
      session.start();
    }

    console.log(`[sessions] Started ${this.sessions.size} session(s)`);
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => s.getInfo());
  }

  getDefaultSessionId(): string | null {
    const first = this.sessions.values().next();
    return first.done ? null : first.value.id;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getLatestSnapshot(sessionId: string): SessionScreen | null {
    return this.sessions.get(sessionId)?.getLatestSnapshot() ?? null;
  }

  writeInput(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session with id: ${sessionId}`);
    session.writeInput(text);
  }

  writeRaw(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session with id: ${sessionId}`);
    session.writeRaw(data);
  }

  sendSignal(sessionId: string, signal: 'SIGINT' | 'SIGKILL'): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session with id: ${sessionId}`);
    session.sendSignal(signal);
  }

  resizeAll(cols: number, rows: number): void {
    for (const session of this.sessions.values()) {
      if (session.state === 'running') {
        session.resize(cols, rows);
      }
    }
  }

  /** Restart an exited session — dispose old PTY and spawn fresh. */
  restartSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`No session with id: ${sessionId}`);
    if (session.state !== 'exited') throw new Error(`Session ${sessionId} is still running`);

    session.restart();

    // Re-wire snapshot callback (the new pipeline needs it)
    session.onSnapshot = (snapshot: SessionScreen) => {
      this._onSnapshot?.(snapshot);
    };
    session.onExit = (sid: string, code: number) => {
      this.clearKillTimer(sid);
      this.clearIdleTimer(sid);
      this._onSessionExit?.(sid, code);
    };

    console.log(`[sessions] Restarted session: ${sessionId}`);
  }

  /** Track a client connection (call after successful authentication). */
  clientConnected(clientId: string): void {
    this.authenticatedClients.add(clientId);
    // Clients connected — cancel all idle timers
    this.cancelAllIdleTimers();
  }

  /** Track a client disconnection. */
  clientDisconnected(clientId: string): void {
    this.authenticatedClients.delete(clientId);

    if (this.authenticatedClients.size === 0) {
      // All clients gone — start idle timers for running sessions
      this.startIdleTimers();
    }
  }

  /** Start idle timers for all running sessions. */
  private startIdleTimers(): void {
    const timeoutMs = this.config.idleTimeoutMs;
    if (timeoutMs <= 0) return;

    for (const session of this.sessions.values()) {
      if (session.state !== 'running') continue;
      if (this.idleTimers.has(session.id)) continue;

      console.log(`[sessions] Starting idle timer for session ${session.id} (${timeoutMs}ms)`);
      this.idleTimers.set(session.id, setTimeout(() => {
        this.idleTimers.delete(session.id);
        if (session.state !== 'running') return;

        console.log(`[sessions] Idle timeout: sending SIGINT to session ${session.id}`);
        try {
          session.sendSignal('SIGINT');
        } catch { /* session may have exited */ }

        // Start kill timer — SIGKILL after 10s if still running
        this.killTimers.set(session.id, setTimeout(() => {
          this.killTimers.delete(session.id);
          if (session.state !== 'running') return;

          console.log(`[sessions] Kill timeout: sending SIGKILL to session ${session.id}`);
          try {
            session.sendSignal('SIGKILL');
          } catch { /* session may have exited */ }
        }, 10_000));
      }, timeoutMs));
    }
  }

  /** Cancel all idle and kill timers (client reconnected). */
  private cancelAllIdleTimers(): void {
    for (const [id, timer] of this.idleTimers) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    for (const [id, timer] of this.killTimers) {
      clearTimeout(timer);
    }
    this.killTimers.clear();

    if (this.sessions.size > 0) {
      console.log('[sessions] Idle timers cancelled (client reconnected)');
    }
  }

  private clearIdleTimer(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
  }

  private clearKillTimer(sessionId: string): void {
    const timer = this.killTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.killTimers.delete(sessionId);
    }
  }

  stopAll(): void {
    this.cancelAllIdleTimers();
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    console.log('[sessions] All sessions stopped');
  }
}

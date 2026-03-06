import { Session } from './Session.js';
import type { Config } from '../config.js';
import type { SessionInfo, SessionScreen } from '../types/protocol.js';
import type { SessionProvider } from '../server/WebSocketServer.js';

export class SessionManager implements SessionProvider {
  private sessions = new Map<string, Session>();
  private _onSnapshot: ((snapshot: SessionScreen) => void) | null = null;

  constructor(private readonly config: Config) {}

  set onSnapshot(cb: ((snapshot: SessionScreen) => void) | null) {
    this._onSnapshot = cb;
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

  stopAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    console.log('[sessions] All sessions stopped');
  }
}

import type { WebSocket } from 'ws';
import type { ServerMessage } from '../types/protocol.js';

export class ClientConnection {
  readonly id: string;
  authenticated = false;
  cols = 80;
  rows = 24;
  activeSessionId: string | null = null;

  private authTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly ws: WebSocket,
    private readonly authTimeoutMs = 5000,
  ) {
    this.id = crypto.randomUUID();

    // Start auth timeout — disconnect if client.hello not received
    this.authTimer = setTimeout(() => {
      if (!this.authenticated) {
        this.sendError('AUTH_TIMEOUT', 'Authentication timeout');
        this.ws.close(4001, 'Auth timeout');
      }
    }, this.authTimeoutMs);
  }

  markAuthenticated(cols: number, rows: number): void {
    this.authenticated = true;
    this.cols = cols;
    this.rows = rows;
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  updateGrid(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  send(message: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  sendError(code: string, message: string): void {
    this.send({ type: 'error', code, message });
  }

  close(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    this.ws.close();
  }
}

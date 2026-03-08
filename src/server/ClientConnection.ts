import type { WebSocket } from 'ws';
import type { DeviceType, Role, ServerMessage } from '../types/protocol.js';

export interface SttStream {
  write(pcm: Buffer): void;
  end(): void;
}

export class ClientConnection {
  readonly id: string;
  authenticated = false;
  cols = 80;
  rows = 24;
  activeSessionId: string | null = null;

  // Role system
  role: Role = 'viewer';
  deviceType: DeviceType = 'glasses';

  // Audio stream state
  audioStream: SttStream | null = null;
  audioSessionId: string | null = null;
  pendingTranscript: { text: string; seq: number; sessionId: string } | null = null;
  private _transcriptSeq = 0;
  private audioTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private audioTimeoutCb: (() => void) | null = null;
  private audioTimeoutMs = 60_000;

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

  nextTranscriptSeq(): number {
    return ++this._transcriptSeq;
  }

  startAudioTimeout(onTimeout: () => void, timeoutMs = 60_000): void {
    this.clearAudioTimeout();
    this.audioTimeoutCb = onTimeout;
    this.audioTimeoutMs = timeoutMs;
    this.audioTimeoutTimer = setTimeout(onTimeout, timeoutMs);
  }

  resetAudioTimeout(): void {
    if (this.audioTimeoutCb) {
      this.clearAudioTimeout();
      this.audioTimeoutTimer = setTimeout(this.audioTimeoutCb, this.audioTimeoutMs);
    }
  }

  clearAudioTimeout(): void {
    if (this.audioTimeoutTimer) {
      clearTimeout(this.audioTimeoutTimer);
      this.audioTimeoutTimer = null;
    }
  }

  close(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    this.clearAudioTimeout();
    if (this.audioStream) {
      this.audioStream.end();
      this.audioStream = null;
    }
    this.ws.close();
  }
}

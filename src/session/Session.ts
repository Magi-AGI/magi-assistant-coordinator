import { VirtualTerminalBuffer } from '../vtb/VirtualTerminalBuffer.js';
import { SnapshotPipeline } from '../vtb/SnapshotPipeline.js';
import { PtyHost } from '../pty/PtyHost.js';
import type { Config, SessionConfig } from '../config.js';
import type { SessionInfo, SessionScreen } from '../types/protocol.js';

export class Session {
  readonly id: string;
  readonly name: string;
  private ptyHost: PtyHost;
  private vtb: VirtualTerminalBuffer;
  private pipeline: SnapshotPipeline;
  private _state: 'running' | 'exited' = 'running';
  private _exitCode: number | null = null;
  private _latestSnapshot: SessionScreen | null = null;
  private _onSnapshot: ((snapshot: SessionScreen) => void) | null = null;

  constructor(sessionConfig: SessionConfig, private readonly config: Config) {
    this.id = sessionConfig.id;
    this.name = sessionConfig.name;

    this.vtb = new VirtualTerminalBuffer(
      config.defaultCols,
      config.defaultRows,
      config.scrollback,
    );

    this.pipeline = new SnapshotPipeline(
      this.id,
      this.vtb,
      config.debounceMs,
      Math.round(1000 / config.fpsCap),
      config.renderBudgetMs,
    );

    this.ptyHost = new PtyHost(
      sessionConfig.shell,
      sessionConfig.args,
      sessionConfig.cwd,
      config.defaultCols,
      config.defaultRows,
    );

    // Wire: PTY → VTB
    this.ptyHost.onData = (data: string) => {
      this.vtb.write(data);

      // Backpressure
      if (this.vtb.pendingBytes > config.backpressureBytes) {
        this.ptyHost.pause();
        console.warn(`[session:${this.id}] Backpressure: paused PTY (${this.vtb.pendingBytes} bytes pending)`);
      }
    };

    // VTB parsed → pipeline
    this.vtb.onWriteParsed = () => {
      this.pipeline.markDirty();

      // Resume PTY if backpressure relieved (50% threshold)
      if (this.ptyHost.paused && this.vtb.pendingBytes < config.backpressureBytes / 2) {
        this.ptyHost.resume();
        console.log(`[session:${this.id}] Backpressure: resumed PTY`);
      }
    };

    // Pipeline → broadcast
    this.pipeline.onSnapshot = (snapshot: SessionScreen) => {
      this._latestSnapshot = snapshot;
      this._onSnapshot?.(snapshot);
    };

    // PTY exit
    this.ptyHost.onExit = (code: number) => {
      this._state = 'exited';
      this._exitCode = code;
      console.log(`[session:${this.id}] PTY exited with code ${code}`);
      // Force a final snapshot
      this._latestSnapshot = this.pipeline.forceSnapshot();
      this._onSnapshot?.(this._latestSnapshot);
    };
  }

  set onSnapshot(cb: ((snapshot: SessionScreen) => void) | null) {
    this._onSnapshot = cb;
  }

  start(): void {
    this.ptyHost.spawn();
    console.log(`[session:${this.id}] Started: ${this.name}`);
  }

  get state(): 'running' | 'exited' { return this._state; }

  getInfo(): SessionInfo {
    return { id: this.id, name: this.name, state: this._state };
  }

  getLatestSnapshot(): SessionScreen | null {
    if (this._latestSnapshot) return this._latestSnapshot;
    // If no snapshot yet, force one
    return this.pipeline.forceSnapshot();
  }

  resize(cols: number, rows: number): void {
    this.vtb.resize(cols, rows);
    this.ptyHost.resize(cols, rows);
  }

  dispose(): void {
    this.pipeline.dispose();
    this.ptyHost.dispose();
    this.vtb.dispose();
  }
}

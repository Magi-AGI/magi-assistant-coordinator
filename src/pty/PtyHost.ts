import * as pty from 'node-pty';
import treeKill from 'tree-kill';

export class PtyHost {
  private process: pty.IPty | null = null;
  private _onData: ((data: string) => void) | null = null;
  private _onExit: ((code: number) => void) | null = null;
  private _paused = false;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly shell: string,
    private readonly args: string[],
    private readonly cwd: string,
    private cols: number,
    private rows: number,
  ) {}

  set onData(cb: ((data: string) => void) | null) { this._onData = cb; }
  set onExit(cb: ((code: number) => void) | null) { this._onExit = cb; }

  spawn(): void {
    this.process = pty.spawn(this.shell, this.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: process.env as Record<string, string>,
    });

    this.process.onData((data: string) => {
      this._onData?.(data);
    });

    this.process.onExit(({ exitCode }: { exitCode: number }) => {
      this._onExit?.(exitCode);
    });
  }

  /** Pause PTY reads (backpressure). */
  pause(): void {
    if (!this._paused) {
      this.process?.pause();
      this._paused = true;
    }
  }

  /** Resume PTY reads. */
  resume(): void {
    if (this._paused) {
      this.process?.resume();
      this._paused = false;
    }
  }

  get paused(): boolean { return this._paused; }

  /** Get the PID of the PTY process. */
  getPid(): number | null {
    return this.process?.pid ?? null;
  }

  /** Debounced resize — waits 500ms after last call. */
  resize(cols: number, rows: number): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.cols = cols;
      this.rows = rows;
      try {
        this.process?.resize(cols, rows);
      } catch (e) {
        // Process may have exited
      }
    }, 500);
  }

  write(data: string): void {
    this.process?.write(data);
  }

  kill(signal?: string): void {
    if (!this.process) return;
    const sig = signal || 'SIGTERM';

    if (sig === 'SIGINT') {
      // SIGINT: deliver directly to the PTY foreground process group.
      // This acts as a normal terminal interrupt (Ctrl+C), not a destructive kill.
      // node-pty's kill() sends the signal to the PTY child process, which the
      // terminal driver delivers to the foreground process group.
      try { this.process.kill(sig); } catch { /* already dead */ }
    } else {
      // SIGKILL/SIGTERM: use tree-kill to terminate the entire process tree.
      const pid = this.process.pid;
      treeKill(pid, sig, (err) => {
        if (err) {
          console.warn(`[pty] tree-kill(${pid}, ${sig}) failed:`, err.message);
          try { this.process?.kill(signal); } catch { /* already dead */ }
        }
      });
    }
  }

  dispose(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.process) {
      const pid = this.process.pid;
      treeKill(pid, 'SIGKILL', () => {});
      this.process = null;
    }
  }
}

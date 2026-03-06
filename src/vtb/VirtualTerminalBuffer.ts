import { Terminal } from '@xterm/headless';

export interface ScreenSnapshot {
  lines: string[];
  cursor: { row: number; col: number };
  scrollback: { totalLines: number; viewportRow: number };
}

export class VirtualTerminalBuffer {
  private terminal: Terminal;
  private _pendingBytes = 0;
  private _onWriteParsed: (() => void) | null = null;
  private _version = 0;

  constructor(cols: number, rows: number, scrollback: number) {
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback,
      allowProposedApi: true,
    });

    // Track when xterm finishes parsing a write batch
    this.terminal.parser.registerCsiHandler({ final: '' as any }, () => false);
  }

  get cols(): number { return this.terminal.cols; }
  get rows(): number { return this.terminal.rows; }
  get pendingBytes(): number { return this._pendingBytes; }
  get version(): number { return this._version; }

  set onWriteParsed(cb: (() => void) | null) {
    this._onWriteParsed = cb;
  }

  write(data: string | Uint8Array): void {
    const len = typeof data === 'string' ? data.length : data.length;
    this._pendingBytes += len;

    this.terminal.write(data, () => {
      this._pendingBytes = Math.max(0, this._pendingBytes - len);
      this._version++;
      this._onWriteParsed?.();
    });
  }

  extractScreen(): ScreenSnapshot {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];

    for (let y = 0; y < this.terminal.rows; y++) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }

    return {
      lines,
      cursor: {
        row: buffer.cursorY,
        col: buffer.cursorX,
      },
      scrollback: {
        totalLines: buffer.length,
        viewportRow: buffer.viewportY,
      },
    };
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

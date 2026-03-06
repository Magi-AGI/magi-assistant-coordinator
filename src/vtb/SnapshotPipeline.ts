import type { VirtualTerminalBuffer } from './VirtualTerminalBuffer.js';
import type { SessionScreen } from '../types/protocol.js';
import { SeqCounter } from '../util/seq.js';

export class SnapshotPipeline {
  private dirty = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBroadcastTime = 0;
  private seq = new SeqCounter();
  private _onSnapshot: ((snapshot: SessionScreen) => void) | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly vtb: VirtualTerminalBuffer,
    private readonly debounceMs: number,
    private readonly minIntervalMs: number, // 1000/fpsCap
    private readonly renderBudgetMs: number,
  ) {}

  set onSnapshot(cb: ((snapshot: SessionScreen) => void) | null) {
    this._onSnapshot = cb;
  }

  /** Call when VTB finishes parsing new data. */
  markDirty(): void {
    this.dirty = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.tryBroadcast();
    }, this.debounceMs);
  }

  /** Bypass debounce + FPS cap (for reconnect, exit). */
  forceSnapshot(): SessionScreen {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    return this.extractAndBroadcast();
  }

  private tryBroadcast(): void {
    const now = Date.now();
    const elapsed = now - this.lastBroadcastTime;

    if (elapsed < this.minIntervalMs) {
      // Schedule for after the interval
      setTimeout(() => this.tryBroadcast(), this.minIntervalMs - elapsed);
      return;
    }

    if (!this.dirty) return;
    this.extractAndBroadcast();
  }

  private extractAndBroadcast(): SessionScreen {
    const start = performance.now();
    const screen = this.vtb.extractScreen();
    const renderMs = performance.now() - start;

    if (renderMs > this.renderBudgetMs) {
      console.warn(`[snapshot] Render took ${renderMs.toFixed(1)}ms (budget: ${this.renderBudgetMs}ms)`);
    }

    this.dirty = false;
    this.lastBroadcastTime = Date.now();

    const snapshot: SessionScreen = {
      type: 'session.screen',
      sessionId: this.sessionId,
      lines: screen.lines,
      version: this.vtb.version,
      cursor: screen.cursor,
      seq: this.seq.next(),
      scrollback: screen.scrollback,
    };

    this._onSnapshot?.(snapshot);
    return snapshot;
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

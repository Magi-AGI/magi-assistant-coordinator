/**
 * Tracks per-client, per-session screen state and computes line-level deltas.
 * Clients that advertise `caps: ["delta"]` receive only changed lines.
 */

export interface ScreenDelta {
  sessionId: string;
  changedLines: Record<number, string>; // lineIndex → newContent
  cursorRow: number;
  cursorCol: number;
  totalLines: number;
  baseSeq: number;
  seq: number;
  version: number;
}

interface CachedScreen {
  lines: string[];
  seq: number;
}

export class ClientScreenTracker {
  // Map<clientId, Map<sessionId, CachedScreen>>
  private cache = new Map<string, Map<string, CachedScreen>>();

  /**
   * Compute a delta between the client's cached screen and new lines.
   * Returns null if no cache exists (caller should send full frame).
   */
  computeDelta(
    clientId: string,
    sessionId: string,
    newLines: string[],
    cursorRow: number,
    cursorCol: number,
    seq: number,
    version: number,
  ): ScreenDelta | null {
    let clientCache = this.cache.get(clientId);
    if (!clientCache) {
      clientCache = new Map();
      this.cache.set(clientId, clientCache);
    }

    const cached = clientCache.get(sessionId);
    if (!cached) {
      // First frame for this client+session — cache and return null (send full)
      clientCache.set(sessionId, { lines: [...newLines], seq });
      return null;
    }

    const baseSeq = cached.seq;
    const changedLines: Record<number, string> = {};

    // Compare each line
    const maxLen = Math.max(cached.lines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      const oldLine = i < cached.lines.length ? cached.lines[i] : undefined;
      const newLine = i < newLines.length ? newLines[i] : undefined;
      if (oldLine !== newLine) {
        // Include line if it exists in new frame, or empty string if truncated
        changedLines[i] = newLine ?? '';
      }
    }

    // Update cache
    clientCache.set(sessionId, { lines: [...newLines], seq });

    return {
      sessionId,
      changedLines,
      cursorRow,
      cursorCol,
      totalLines: newLines.length,
      baseSeq,
      seq,
      version,
    };
  }

  /** Clear all cached screens for a client (on disconnect). */
  resetClient(clientId: string): void {
    this.cache.delete(clientId);
  }

  /** Clear cached screen for a specific client+session (on session switch or resync). */
  resetSession(clientId: string, sessionId: string): void {
    this.cache.get(clientId)?.delete(sessionId);
  }
}

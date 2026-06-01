import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualTerminalBuffer } from '../VirtualTerminalBuffer.js';

describe('VirtualTerminalBuffer', () => {
  let vtb: VirtualTerminalBuffer;

  beforeEach(() => {
    vtb = new VirtualTerminalBuffer(80, 24, 1000);
  });

  it('fires onWriteParsed after a write', async () => {
    const fired = await new Promise<boolean>((resolve) => {
      vtb.onWriteParsed = () => resolve(true);
      vtb.write('hello');
      setTimeout(() => resolve(false), 100);
    });
    expect(fired).toBe(true);
  });

  it('increments version on each parsed write', async () => {
    const versions: number[] = [];
    await new Promise<void>((resolve) => {
      let count = 0;
      vtb.onWriteParsed = () => {
        versions.push(vtb.version);
        if (++count === 3) resolve();
      };
      vtb.write('a');
      vtb.write('b');
      vtb.write('c');
    });
    expect(versions).toEqual([1, 2, 3]);
  });

  it('decrements pendingBytes back to zero after parse', async () => {
    await new Promise<void>((resolve) => {
      vtb.onWriteParsed = () => resolve();
      vtb.write('hello world');
    });
    expect(vtb.pendingBytes).toBe(0);
  });

  it('extractScreen reflects written content after parse', async () => {
    await new Promise<void>((resolve) => {
      vtb.onWriteParsed = () => resolve();
      vtb.write('hello');
    });
    const screen = vtb.extractScreen();
    expect(screen.lines[0].startsWith('hello')).toBe(true);
    expect(screen.cursor.row).toBe(0);
    expect(screen.cursor.col).toBe(5);
  });

  it('handles ANSI escape sequences without breaking the parse callback', async () => {
    const fired = await new Promise<boolean>((resolve) => {
      vtb.onWriteParsed = () => resolve(true);
      vtb.write('\x1b[31mred\x1b[0m');
      setTimeout(() => resolve(false), 100);
    });
    expect(fired).toBe(true);
  });
});

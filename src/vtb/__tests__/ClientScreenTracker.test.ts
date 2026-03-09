import { describe, it, expect, beforeEach } from 'vitest';
import { ClientScreenTracker } from '../ClientScreenTracker.js';

describe('ClientScreenTracker', () => {
  let tracker: ClientScreenTracker;

  beforeEach(() => {
    tracker = new ClientScreenTracker();
  });

  it('first frame returns null (no cache)', () => {
    const delta = tracker.computeDelta('c1', 's1', ['hello', 'world'], 0, 0, 1, 1);
    expect(delta).toBeNull();
  });

  it('identical frame returns empty changedLines', () => {
    tracker.computeDelta('c1', 's1', ['hello', 'world'], 0, 0, 1, 1);
    const delta = tracker.computeDelta('c1', 's1', ['hello', 'world'], 0, 0, 2, 2);
    expect(delta).not.toBeNull();
    expect(delta!.changedLines).toEqual({});
    expect(delta!.baseSeq).toBe(1);
    expect(delta!.seq).toBe(2);
  });

  it('single line change returns only that line', () => {
    tracker.computeDelta('c1', 's1', ['line1', 'line2', 'line3'], 0, 0, 1, 1);
    const delta = tracker.computeDelta('c1', 's1', ['line1', 'CHANGED', 'line3'], 1, 0, 2, 2);
    expect(delta).not.toBeNull();
    expect(delta!.changedLines).toEqual({ 1: 'CHANGED' });
  });

  it('multiple line changes returns all changed lines', () => {
    tracker.computeDelta('c1', 's1', ['a', 'b', 'c'], 0, 0, 1, 1);
    const delta = tracker.computeDelta('c1', 's1', ['A', 'b', 'C'], 0, 0, 2, 2);
    expect(delta!.changedLines).toEqual({ 0: 'A', 2: 'C' });
  });

  it('line count change is tracked', () => {
    tracker.computeDelta('c1', 's1', ['a', 'b'], 0, 0, 1, 1);
    const delta = tracker.computeDelta('c1', 's1', ['a', 'b', 'c'], 0, 0, 2, 2);
    expect(delta!.changedLines).toEqual({ 2: 'c' });
    expect(delta!.totalLines).toBe(3);
  });

  it('resetClient clears cache', () => {
    tracker.computeDelta('c1', 's1', ['hello'], 0, 0, 1, 1);
    tracker.resetClient('c1');
    const delta = tracker.computeDelta('c1', 's1', ['hello'], 0, 0, 2, 2);
    expect(delta).toBeNull(); // no cache → first frame again
  });

  it('resetSession clears only that session', () => {
    tracker.computeDelta('c1', 's1', ['hello'], 0, 0, 1, 1);
    tracker.computeDelta('c1', 's2', ['world'], 0, 0, 1, 1);
    tracker.resetSession('c1', 's1');

    // s1 should be reset (returns null)
    const d1 = tracker.computeDelta('c1', 's1', ['hello'], 0, 0, 2, 2);
    expect(d1).toBeNull();

    // s2 should still have cache
    const d2 = tracker.computeDelta('c1', 's2', ['world'], 0, 0, 2, 2);
    expect(d2).not.toBeNull();
    expect(d2!.changedLines).toEqual({});
  });

  it('different sessions tracked independently', () => {
    tracker.computeDelta('c1', 's1', ['aaa'], 0, 0, 1, 1);
    tracker.computeDelta('c1', 's2', ['bbb'], 0, 0, 1, 1);

    const d1 = tracker.computeDelta('c1', 's1', ['AAA'], 0, 0, 2, 2);
    const d2 = tracker.computeDelta('c1', 's2', ['bbb'], 0, 0, 2, 2);

    expect(d1!.changedLines).toEqual({ 0: 'AAA' });
    expect(d2!.changedLines).toEqual({});
  });

  it('different clients tracked independently', () => {
    tracker.computeDelta('c1', 's1', ['hello'], 0, 0, 1, 1);
    // c2 has no cache yet
    const d2 = tracker.computeDelta('c2', 's1', ['hello'], 0, 0, 1, 1);
    expect(d2).toBeNull();

    // c1 should have cache
    const d1 = tracker.computeDelta('c1', 's1', ['hello'], 0, 0, 2, 2);
    expect(d1!.changedLines).toEqual({});
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoleManager } from '../RoleManager.js';
import { ClientConnection } from '../ClientConnection.js';

/** Create a mock ClientConnection without a real WebSocket. */
function mockClient(deviceType: 'glasses' | 'phone' = 'glasses'): ClientConnection {
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: () => {},
    close: () => {},
  } as any;
  const client = new ClientConnection(ws, 999999);
  client.deviceType = deviceType;
  return client;
}

describe('RoleManager grace disconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers auto-promote during grace period', () => {
    const rm = new RoleManager(5000);
    const c1 = mockClient('glasses');
    const c2 = mockClient('phone');
    rm.addClient(c1);
    rm.addClient(c2);

    // Operator disconnects — no immediate promotion
    const promoted = rm.removeClient(c1.id);
    expect(promoted).toBeNull();
    expect(c2.role).toBe('viewer'); // Not promoted yet
  });

  it('auto-promotes after grace timer expires', () => {
    const rm = new RoleManager(5000);
    const onPromote = vi.fn();
    rm.onAutoPromote = onPromote;

    const c1 = mockClient('glasses');
    const c2 = mockClient('phone');
    rm.addClient(c1);
    rm.addClient(c2);

    rm.removeClient(c1.id);

    // Advance timer past grace period
    vi.advanceTimersByTime(5001);

    expect(onPromote).toHaveBeenCalledOnce();
    expect(c2.role).toBe('operator');
  });

  it('reconnecting client gets operator during grace (via addClient)', () => {
    const rm = new RoleManager(5000);
    const onPromote = vi.fn();
    rm.onAutoPromote = onPromote;

    const c1 = mockClient('glasses');
    const c2 = mockClient('phone');
    rm.addClient(c1);
    rm.addClient(c2);

    rm.removeClient(c1.id);

    // Glasses reconnects with a new client ID (as happens in real reconnects)
    const c1Reconnected = mockClient('glasses');
    const role = rm.addClient(c1Reconnected);
    expect(role).toBe('operator');

    // Grace timer fires but does nothing (operator already assigned)
    vi.advanceTimersByTime(5001);
    expect(onPromote).not.toHaveBeenCalled();
    expect(c2.role).toBe('viewer');
  });

  it('claim during grace cancels grace and succeeds', () => {
    const rm = new RoleManager(5000);
    const onPromote = vi.fn();
    rm.onAutoPromote = onPromote;

    const c1 = mockClient('glasses');
    const c2 = mockClient('phone');
    rm.addClient(c1);
    rm.addClient(c2);

    rm.removeClient(c1.id);

    // Phone claims during grace
    const success = rm.claimOperator(c2, false);
    expect(success).toBe(true);
    expect(c2.role).toBe('operator');

    // Grace timer fires but does nothing
    vi.advanceTimersByTime(5001);
    expect(onPromote).not.toHaveBeenCalled();
  });

  it('cancelGrace stops the timer', () => {
    const rm = new RoleManager(5000);
    const onPromote = vi.fn();
    rm.onAutoPromote = onPromote;

    const c1 = mockClient('glasses');
    const c2 = mockClient('phone');
    rm.addClient(c1);
    rm.addClient(c2);

    rm.removeClient(c1.id);
    rm.cancelGrace();

    vi.advanceTimersByTime(10000);
    expect(onPromote).not.toHaveBeenCalled();
    expect(c2.role).toBe('viewer'); // Never promoted
  });

  it('graceMs=0 gives instant auto-promote (backward compat)', () => {
    const rm = new RoleManager(0);
    const c1 = mockClient('glasses');
    const c2 = mockClient('phone');
    rm.addClient(c1);
    rm.addClient(c2);

    const promoted = rm.removeClient(c1.id);
    expect(promoted).not.toBeNull();
    expect(promoted!.id).toBe(c2.id);
    expect(c2.role).toBe('operator');
  });

  it('grace prefers phone for auto-promote after timeout', () => {
    const rm = new RoleManager(5000);
    const onPromote = vi.fn();
    rm.onAutoPromote = onPromote;

    const op = mockClient('glasses');
    const g2 = mockClient('glasses');
    const phone = mockClient('phone');
    rm.addClient(op);
    rm.addClient(g2);
    rm.addClient(phone);

    rm.removeClient(op.id);

    vi.advanceTimersByTime(5001);
    expect(onPromote).toHaveBeenCalledOnce();
    expect(phone.role).toBe('operator');
    expect(g2.role).toBe('viewer');
  });

  it('no promotion if all clients leave during grace', () => {
    const rm = new RoleManager(5000);
    const onPromote = vi.fn();
    rm.onAutoPromote = onPromote;

    const c1 = mockClient('glasses');
    const c2 = mockClient('phone');
    rm.addClient(c1);
    rm.addClient(c2);

    rm.removeClient(c1.id); // operator leaves, grace starts
    rm.removeClient(c2.id); // last viewer leaves

    vi.advanceTimersByTime(5001);
    expect(onPromote).not.toHaveBeenCalled();
  });
});

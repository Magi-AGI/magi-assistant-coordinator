import { describe, it, expect, beforeEach } from 'vitest';
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
  const client = new ClientConnection(ws, 999999); // very long auth timeout
  client.deviceType = deviceType;
  return client;
}

describe('RoleManager', () => {
  let rm: RoleManager;

  beforeEach(() => {
    rm = new RoleManager();
  });

  it('first client gets operator', () => {
    const c1 = mockClient();
    const role = rm.addClient(c1);
    expect(role).toBe('operator');
    expect(c1.role).toBe('operator');
    expect(rm.isOperator(c1.id)).toBe(true);
  });

  it('second client gets viewer', () => {
    const c1 = mockClient();
    const c2 = mockClient();
    rm.addClient(c1);
    const role = rm.addClient(c2);
    expect(role).toBe('viewer');
    expect(c2.role).toBe('viewer');
    expect(rm.isOperator(c2.id)).toBe(false);
  });

  it('phone can claim from glasses without force', () => {
    const glasses = mockClient('glasses');
    const phone = mockClient('phone');
    rm.addClient(glasses);
    rm.addClient(phone);

    const success = rm.claimOperator(phone, false);
    expect(success).toBe(true);
    expect(phone.role).toBe('operator');
    expect(glasses.role).toBe('viewer');
  });

  it('glasses cannot claim from phone without force', () => {
    const phone = mockClient('phone');
    const glasses = mockClient('glasses');
    rm.addClient(phone); // phone is operator
    rm.addClient(glasses);

    const success = rm.claimOperator(glasses, false);
    expect(success).toBe(false);
    expect(phone.role).toBe('operator');
    expect(glasses.role).toBe('viewer');
  });

  it('force claim always succeeds', () => {
    const phone = mockClient('phone');
    const glasses = mockClient('glasses');
    rm.addClient(phone);
    rm.addClient(glasses);

    const success = rm.claimOperator(glasses, true);
    expect(success).toBe(true);
    expect(glasses.role).toBe('operator');
    expect(phone.role).toBe('viewer');
  });

  it('claiming when already operator returns true', () => {
    const c1 = mockClient();
    rm.addClient(c1);
    expect(rm.claimOperator(c1, false)).toBe(true);
  });

  it('operator disconnect auto-promotes next client', () => {
    const c1 = mockClient();
    const c2 = mockClient();
    rm.addClient(c1);
    rm.addClient(c2);

    const promoted = rm.removeClient(c1.id);
    expect(promoted).not.toBeNull();
    expect(promoted!.id).toBe(c2.id);
    expect(c2.role).toBe('operator');
  });

  it('auto-promote prefers phone over glasses', () => {
    const op = mockClient('glasses');
    const glasses2 = mockClient('glasses');
    const phone = mockClient('phone');
    rm.addClient(op);
    rm.addClient(glasses2);
    rm.addClient(phone);

    const promoted = rm.removeClient(op.id);
    expect(promoted).not.toBeNull();
    expect(promoted!.id).toBe(phone.id);
    expect(phone.role).toBe('operator');
  });

  it('viewer disconnect returns null (no role change)', () => {
    const c1 = mockClient();
    const c2 = mockClient();
    rm.addClient(c1);
    rm.addClient(c2);

    const result = rm.removeClient(c2.id);
    expect(result).toBeNull();
    expect(c1.role).toBe('operator');
  });

  it('last client disconnect returns null', () => {
    const c1 = mockClient();
    rm.addClient(c1);

    const result = rm.removeClient(c1.id);
    expect(result).toBeNull();
  });

  it('roleVersion increments on every role change', () => {
    const c1 = mockClient('glasses');
    const c2 = mockClient('phone');

    expect(rm.roleVersion).toBe(0);

    rm.addClient(c1); // +1 (first connect)
    expect(rm.roleVersion).toBe(1);

    rm.addClient(c2); // no increment (viewer)
    expect(rm.roleVersion).toBe(1);

    rm.claimOperator(c2, false); // +1 (phone priority)
    expect(rm.roleVersion).toBe(2);

    rm.removeClient(c2.id); // +1 (auto-promote)
    expect(rm.roleVersion).toBe(3);
  });

  it('getClientInfos returns all clients', () => {
    const c1 = mockClient('glasses');
    const c2 = mockClient('phone');
    rm.addClient(c1);
    rm.addClient(c2);

    const infos = rm.getClientInfos();
    expect(infos).toHaveLength(2);
    expect(infos.find(i => i.id === c1.id)?.role).toBe('operator');
    expect(infos.find(i => i.id === c2.id)?.role).toBe('viewer');
  });
});

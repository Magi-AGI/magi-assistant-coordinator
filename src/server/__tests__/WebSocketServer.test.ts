import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketServer } from '../WebSocketServer.js';
import type { SessionProvider } from '../WebSocketServer.js';
import type { Config } from '../../config.js';
import type { SessionInfo, SessionScreen, ServerMessage } from '../../types/protocol.js';
import { defaultSttConfig } from '../../stt/types.js';

/** Minimal config for tests. */
function testConfig(port: number): Config {
  return {
    port,
    token: 'test-token',
    sessions: [],
    logLevel: 'error',
    maxSessions: 10,
    defaultCols: 80,
    defaultRows: 24,
    scrollback: 5000,
    fpsCap: 10,
    debounceMs: 50,
    renderBudgetMs: 10,
    backpressureBytes: 1024 * 1024,
    stt: defaultSttConfig(),
    classification: { autoSendConfidence: 0.9 },
    graceDisconnectMs: 0,   // instant auto-promote in tests
    idleTimeoutMs: 300_000,
  };
}

/** Stub session provider that records calls. */
function mockSessionProvider(): SessionProvider & {
  inputCalls: { sessionId: string; text: string }[];
  rawCalls: { sessionId: string; data: string }[];
  signalCalls: { sessionId: string; signal: string }[];
  resizeCalls: { cols: number; rows: number }[];
  clientCount: number;
} {
  const sessions: SessionInfo[] = [
    { id: 'sess-1', name: 'main', state: 'running' },
  ];

  return {
    inputCalls: [],
    rawCalls: [],
    signalCalls: [],
    resizeCalls: [],
    clientCount: 0,
    listSessions: () => sessions,
    getDefaultSessionId: () => 'sess-1',
    getLatestSnapshot: () => null,
    writeInput(sessionId, text) {
      this.inputCalls.push({ sessionId, text });
    },
    writeRaw(sessionId, data) {
      this.rawCalls.push({ sessionId, data });
    },
    sendSignal(sessionId, signal) {
      this.signalCalls.push({ sessionId, signal });
    },
    restartSession() {},
    resizeAll(cols, rows) {
      this.resizeCalls.push({ cols, rows });
    },
    clientConnected(_clientId: string) {
      this.clientCount++;
    },
    clientDisconnected(_clientId: string) {
      this.clientCount--;
    },
  };
}

/** Connect a WS client and collect all received messages. */
function connectClient(port: number): Promise<{
  ws: WebSocket;
  messages: ServerMessage[];
  waitForMessage: (predicate: (msg: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>;
  send: (msg: any) => void;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: ServerMessage[] = [];

    ws.on('open', () => {
      const send = (msg: any) => ws.send(JSON.stringify(msg));

      const waitForMessage = (
        predicate: (msg: ServerMessage) => boolean,
        timeoutMs = 2000,
      ): Promise<ServerMessage> => {
        // Check already-received messages first
        const existing = messages.find(predicate);
        if (existing) return Promise.resolve(existing);

        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            rej(new Error(`Timed out waiting for message. Got: ${JSON.stringify(messages.map(m => m.type))}`));
          }, timeoutMs);

          const handler = (data: Buffer) => {
            const msg = JSON.parse(data.toString()) as ServerMessage;
            if (predicate(msg)) {
              clearTimeout(timer);
              ws.off('message', handler);
              res(msg);
            }
          };
          ws.on('message', handler);
        });
      };

      resolve({
        ws,
        messages,
        waitForMessage,
        send,
        close: () => ws.close(),
      });
    });

    ws.on('message', (data: Buffer) => {
      messages.push(JSON.parse(data.toString()));
    });

    ws.on('error', reject);
  });
}

/** Get a random port to avoid collisions between tests. */
let nextPort = 19100 + Math.floor(Math.random() * 1000);
function getPort(): number {
  return nextPort++;
}

describe('WebSocketServer integration', () => {
  let server: WebSocketServer;
  let provider: ReturnType<typeof mockSessionProvider>;
  let port: number;

  beforeEach(() => {
    port = getPort();
    provider = mockSessionProvider();
    server = new WebSocketServer(testConfig(port), provider);
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  // ── Auth flow ──

  it('accepts valid token and returns hello.ok with role', async () => {
    const c = await connectClient(port);
    c.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'glasses',
    });

    const hello = await c.waitForMessage(m => m.type === 'hello.ok');
    expect(hello.type).toBe('hello.ok');
    expect((hello as any).role).toBe('operator');
    expect((hello as any).sessions).toHaveLength(1);
    expect((hello as any).activeSessionId).toBe('sess-1');
    expect((hello as any).clients).toBeDefined();
    expect((hello as any).roleVersion).toBeGreaterThan(0);
    c.close();
  });

  it('rejects invalid token with AUTH_FAILED', async () => {
    const c = await connectClient(port);
    c.send({
      type: 'client.hello',
      token: 'wrong-token',
      grid: { cols: 80, rows: 24 },
    });

    const err = await c.waitForMessage(m => m.type === 'error');
    expect((err as any).code).toBe('AUTH_FAILED');
    c.close();
  });

  it('rejects messages before auth with NOT_AUTHENTICATED', async () => {
    const c = await connectClient(port);
    c.send({ type: 'session.list' });

    const err = await c.waitForMessage(m => m.type === 'error');
    expect((err as any).code).toBe('NOT_AUTHENTICATED');
    c.close();
  });

  it('defaults deviceType to glasses when omitted (backward compat)', async () => {
    const c = await connectClient(port);
    c.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      // no deviceType
    });

    const hello = await c.waitForMessage(m => m.type === 'hello.ok');
    expect((hello as any).role).toBe('operator');
    // The client info should show 'glasses' as deviceType
    const clients = (hello as any).clients;
    expect(clients).toHaveLength(1);
    expect(clients[0].deviceType).toBe('glasses');
    c.close();
  });

  // ── Role enforcement ──

  it('viewer gets NOT_OPERATOR for session.input', async () => {
    // First client = operator
    const c1 = await connectClient(port);
    c1.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
    });
    await c1.waitForMessage(m => m.type === 'hello.ok');

    // Second client = viewer
    const c2 = await connectClient(port);
    c2.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
    });
    const hello2 = await c2.waitForMessage(m => m.type === 'hello.ok');
    expect((hello2 as any).role).toBe('viewer');

    // Viewer tries to send input
    c2.send({
      type: 'session.input',
      sessionId: 'sess-1',
      text: 'ls',
      source: 'keyboard',
    });

    const err = await c2.waitForMessage(m => m.type === 'error');
    expect((err as any).code).toBe('NOT_OPERATOR');
    expect(provider.inputCalls).toHaveLength(0);

    c1.close();
    c2.close();
  });

  it('viewer gets NOT_OPERATOR for session.signal', async () => {
    const c1 = await connectClient(port);
    c1.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
    });
    await c1.waitForMessage(m => m.type === 'hello.ok');

    const c2 = await connectClient(port);
    c2.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
    });
    await c2.waitForMessage(m => m.type === 'hello.ok');

    c2.send({
      type: 'session.signal',
      sessionId: 'sess-1',
      signal: 'SIGINT',
    });

    const err = await c2.waitForMessage(m => m.type === 'error');
    expect((err as any).code).toBe('NOT_OPERATOR');
    expect(provider.signalCalls).toHaveLength(0);

    c1.close();
    c2.close();
  });

  it('viewer gets NOT_OPERATOR for session.raw', async () => {
    const c1 = await connectClient(port);
    c1.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
    });
    await c1.waitForMessage(m => m.type === 'hello.ok');

    const c2 = await connectClient(port);
    c2.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
    });
    await c2.waitForMessage(m => m.type === 'hello.ok');

    c2.send({
      type: 'session.raw',
      sessionId: 'sess-1',
      data: '\x03',
    });

    const err = await c2.waitForMessage(m => m.type === 'error');
    expect((err as any).code).toBe('NOT_OPERATOR');
    expect(provider.rawCalls).toHaveLength(0);

    c1.close();
    c2.close();
  });

  it('operator can send session.input', async () => {
    const c = await connectClient(port);
    c.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
    });
    await c.waitForMessage(m => m.type === 'hello.ok');

    c.send({
      type: 'session.input',
      sessionId: 'sess-1',
      text: 'ls -la',
      source: 'keyboard',
    });

    const accepted = await c.waitForMessage(m => m.type === 'input.accepted');
    expect((accepted as any).text).toBe('ls -la');
    expect(provider.inputCalls).toHaveLength(1);
    expect(provider.inputCalls[0]).toEqual({ sessionId: 'sess-1', text: 'ls -la' });
    c.close();
  });

  // ── session.raw ──

  it('operator can send session.raw', async () => {
    const c = await connectClient(port);
    c.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
    });
    await c.waitForMessage(m => m.type === 'hello.ok');

    c.send({
      type: 'session.raw',
      sessionId: 'sess-1',
      data: '\x03',
    });

    // session.raw has no reply — wait briefly then check provider
    await new Promise(r => setTimeout(r, 100));
    expect(provider.rawCalls).toHaveLength(1);
    expect(provider.rawCalls[0]).toEqual({ sessionId: 'sess-1', data: '\x03' });
    c.close();
  });

  // ── Role claim ──

  it('phone claims operator from glasses via role.claim', async () => {
    // Glasses connects first → operator
    const glasses = await connectClient(port);
    glasses.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'glasses',
    });
    await glasses.waitForMessage(m => m.type === 'hello.ok');

    // Phone connects → viewer
    const phone = await connectClient(port);
    phone.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'phone',
    });
    const phoneHello = await phone.waitForMessage(m => m.type === 'hello.ok');
    expect((phoneHello as any).role).toBe('viewer');

    // Phone claims operator
    phone.send({ type: 'role.claim', force: false });

    // Phone should get role.granted
    const granted = await phone.waitForMessage(m => m.type === 'role.granted');
    expect((granted as any).role).toBe('operator');

    // Glasses should get role.revoked
    const revoked = await glasses.waitForMessage(m => m.type === 'role.revoked');
    expect((revoked as any).newRole).toBe('viewer');
    expect((revoked as any).reason).toBe('phone_priority');

    glasses.close();
    phone.close();
  });

  it('glasses cannot claim from phone without force', async () => {
    // Phone connects first → operator
    const phone = await connectClient(port);
    phone.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'phone',
    });
    await phone.waitForMessage(m => m.type === 'hello.ok');

    // Glasses connects → viewer
    const glasses = await connectClient(port);
    glasses.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'glasses',
    });
    await glasses.waitForMessage(m => m.type === 'hello.ok');

    // Glasses tries to claim without force
    glasses.send({ type: 'role.claim', force: false });

    const err = await glasses.waitForMessage(m => m.type === 'error');
    expect((err as any).code).toBe('ROLE_DENIED');

    phone.close();
    glasses.close();
  });

  // ── Client join/leave broadcasts ──

  it('broadcasts client.joined when new client connects', async () => {
    const c1 = await connectClient(port);
    c1.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'glasses',
    });
    await c1.waitForMessage(m => m.type === 'hello.ok');

    // Second client connects
    const c2 = await connectClient(port);
    c2.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'phone',
    });

    // c1 should receive client.joined
    const joined = await c1.waitForMessage(m => m.type === 'client.joined');
    expect((joined as any).deviceType).toBe('phone');
    expect((joined as any).role).toBe('viewer');

    c1.close();
    c2.close();
  });

  it('broadcasts client.left and auto-promotes on operator disconnect', async () => {
    const c1 = await connectClient(port);
    c1.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
    });
    await c1.waitForMessage(m => m.type === 'hello.ok');

    const c2 = await connectClient(port);
    c2.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
    });
    const hello2 = await c2.waitForMessage(m => m.type === 'hello.ok');
    expect((hello2 as any).role).toBe('viewer');

    // Operator disconnects
    c1.close();

    // c2 should get client.left and role.granted
    const left = await c2.waitForMessage(m => m.type === 'client.left');
    expect((left as any).clientId).toBeDefined();

    const granted = await c2.waitForMessage(m => m.type === 'role.granted');
    expect((granted as any).role).toBe('operator');

    c2.close();
  });

  // ── Session operations ──

  it('viewer can list and switch sessions (read-only allowed)', async () => {
    const c1 = await connectClient(port);
    c1.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
    });
    await c1.waitForMessage(m => m.type === 'hello.ok');

    const c2 = await connectClient(port);
    c2.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
    });
    await c2.waitForMessage(m => m.type === 'hello.ok');

    // Viewer can list sessions
    c2.send({ type: 'session.list' });
    const list = await c2.waitForMessage(m => m.type === 'session.list.result');
    expect((list as any).sessions).toHaveLength(1);

    // Viewer can switch sessions
    c2.send({ type: 'session.switch', sessionId: 'sess-1' });
    const switched = await c2.waitForMessage(m => m.type === 'session.switched');
    expect((switched as any).sessionId).toBe('sess-1');

    c1.close();
    c2.close();
  });
});

describe('Grace-period emergency signals', () => {
  let server: WebSocketServer;
  let provider: ReturnType<typeof mockSessionProvider>;
  let port: number;

  beforeEach(() => {
    port = getPort();
    provider = mockSessionProvider();
    // Use a long grace period so the timer doesn't fire during the test
    const cfg = testConfig(port);
    cfg.graceDisconnectMs = 60_000;
    server = new WebSocketServer(cfg, provider);
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it('viewer can send session.signal during grace period (no operator)', async () => {
    // Glasses = operator
    const glasses = await connectClient(port);
    glasses.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'glasses',
    });
    await glasses.waitForMessage(m => m.type === 'hello.ok');

    // Phone = viewer
    const phone = await connectClient(port);
    phone.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 120, rows: 40 },
      deviceType: 'phone',
    });
    await phone.waitForMessage(m => m.type === 'hello.ok');

    // Operator disconnects → grace period starts (no auto-promote yet)
    glasses.close();
    await phone.waitForMessage(m => m.type === 'client.left');

    // Viewer sends session.signal during grace — should succeed
    phone.send({ type: 'session.signal', sessionId: 'sess-1', signal: 'SIGINT' });
    const accepted = await phone.waitForMessage(m => m.type === 'signal.accepted');
    expect((accepted as any).sessionId).toBe('sess-1');
    expect((accepted as any).signal).toBe('SIGINT');

    expect(provider.signalCalls).toContainEqual({ sessionId: 'sess-1', signal: 'SIGINT' });

    phone.close();
  });

  it('viewer cannot send session.input during grace period', async () => {
    // Glasses = operator
    const glasses = await connectClient(port);
    glasses.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'glasses',
    });
    await glasses.waitForMessage(m => m.type === 'hello.ok');

    // Phone = viewer
    const phone = await connectClient(port);
    phone.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 120, rows: 40 },
      deviceType: 'phone',
    });
    await phone.waitForMessage(m => m.type === 'hello.ok');

    // Operator disconnects → grace period
    glasses.close();
    await phone.waitForMessage(m => m.type === 'client.left');

    // Viewer sends session.input during grace — should be rejected
    phone.send({ type: 'session.input', sessionId: 'sess-1', text: 'hello', source: 'keyboard' });
    const err = await phone.waitForMessage(m => m.type === 'error');
    expect((err as any).code).toBe('NOT_OPERATOR');
    expect(provider.inputCalls).toHaveLength(0);

    phone.close();
  });

  it('viewer signal is blocked when operator exists', async () => {
    // Glasses = operator (stays connected)
    const glasses = await connectClient(port);
    glasses.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'glasses',
    });
    await glasses.waitForMessage(m => m.type === 'hello.ok');

    // Phone = viewer
    const phone = await connectClient(port);
    phone.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 120, rows: 40 },
      deviceType: 'phone',
    });
    await phone.waitForMessage(m => m.type === 'hello.ok');

    // Viewer sends signal while operator is connected — should fail
    phone.send({ type: 'session.signal', sessionId: 'sess-1', signal: 'SIGINT' });
    const err = await phone.waitForMessage(m => m.type === 'error');
    expect((err as any).code).toBe('NOT_OPERATOR');
    expect(provider.signalCalls).toHaveLength(0);

    glasses.close();
    phone.close();
  });
});

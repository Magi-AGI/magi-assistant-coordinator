import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketServer } from '../WebSocketServer.js';
import type { SessionProvider } from '../WebSocketServer.js';
import type { Config } from '../../config.js';
import type { SessionInfo, SessionScreen, ServerMessage } from '../../types/protocol.js';
import { defaultSttConfig } from '../../stt/types.js';

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

function mockSessionProvider(): SessionProvider & {
  resizeCalls: { cols: number; rows: number }[];
  clientCount: number;
} {
  const sessions: SessionInfo[] = [
    { id: 'sess-1', name: 'main', state: 'running' },
  ];

  return {
    resizeCalls: [],
    clientCount: 0,
    listSessions: () => sessions,
    getDefaultSessionId: () => 'sess-1',
    getLatestSnapshot: () => null,
    writeInput() {},
    writeRaw() {},
    sendSignal() {},
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

let nextPort = 20100 + Math.floor(Math.random() * 1000);
function getPort(): number {
  return nextPort++;
}

describe('Grid consensus', () => {
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

  it('operator grid resizes PTY on connect', async () => {
    const glasses = await connectClient(port);
    glasses.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'glasses',
    });
    await glasses.waitForMessage(m => m.type === 'hello.ok');

    // Operator connected — should have resized
    expect(provider.resizeCalls).toContainEqual({ cols: 80, rows: 24 });
    glasses.close();
  });

  it('viewer grid does NOT resize PTY', async () => {
    // Glasses = operator
    const glasses = await connectClient(port);
    glasses.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'glasses',
    });
    await glasses.waitForMessage(m => m.type === 'hello.ok');

    provider.resizeCalls = []; // Reset

    // Phone = viewer with different grid
    const phone = await connectClient(port);
    phone.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 120, rows: 40 },
      deviceType: 'phone',
    });
    await phone.waitForMessage(m => m.type === 'hello.ok');

    // Viewer's grid should NOT trigger resize
    expect(provider.resizeCalls).toHaveLength(0);

    glasses.close();
    phone.close();
  });

  it('viewer client.grid does NOT resize PTY', async () => {
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

    provider.resizeCalls = []; // Reset

    // Viewer sends client.grid
    phone.send({ type: 'client.grid', cols: 200, rows: 50 });
    await new Promise(r => setTimeout(r, 100));

    // Should NOT resize
    expect(provider.resizeCalls).toHaveLength(0);

    glasses.close();
    phone.close();
  });

  it('operator client.grid resizes PTY', async () => {
    const glasses = await connectClient(port);
    glasses.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'glasses',
    });
    await glasses.waitForMessage(m => m.type === 'hello.ok');

    provider.resizeCalls = []; // Reset

    // Operator sends client.grid
    glasses.send({ type: 'client.grid', cols: 100, rows: 30 });
    await new Promise(r => setTimeout(r, 100));

    expect(provider.resizeCalls).toContainEqual({ cols: 100, rows: 30 });

    glasses.close();
  });

  it('role claim resizes PTY to new operator grid', async () => {
    // Glasses = operator (80x24)
    const glasses = await connectClient(port);
    glasses.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'glasses',
    });
    await glasses.waitForMessage(m => m.type === 'hello.ok');

    // Phone = viewer (120x40)
    const phone = await connectClient(port);
    phone.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 120, rows: 40 },
      deviceType: 'phone',
    });
    await phone.waitForMessage(m => m.type === 'hello.ok');

    provider.resizeCalls = []; // Reset

    // Phone claims operator
    phone.send({ type: 'role.claim', force: false });
    await phone.waitForMessage(m => m.type === 'role.granted');

    // Should resize to phone's grid
    expect(provider.resizeCalls).toContainEqual({ cols: 120, rows: 40 });

    glasses.close();
    phone.close();
  });

  it('operator disconnect + auto-promote resizes PTY to new operator grid', async () => {
    // Glasses = operator (80x24)
    const glasses = await connectClient(port);
    glasses.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 80, rows: 24 },
      deviceType: 'glasses',
    });
    await glasses.waitForMessage(m => m.type === 'hello.ok');

    // Phone = viewer (120x40)
    const phone = await connectClient(port);
    phone.send({
      type: 'client.hello',
      token: 'test-token',
      grid: { cols: 120, rows: 40 },
      deviceType: 'phone',
    });
    await phone.waitForMessage(m => m.type === 'hello.ok');

    provider.resizeCalls = []; // Reset

    // Operator disconnects → phone auto-promoted (graceMs=0)
    glasses.close();
    await phone.waitForMessage(m => m.type === 'role.granted');

    // Should resize to phone's grid
    expect(provider.resizeCalls).toContainEqual({ cols: 120, rows: 40 });

    phone.close();
  });
});

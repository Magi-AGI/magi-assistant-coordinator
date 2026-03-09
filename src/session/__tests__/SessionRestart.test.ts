import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketServer } from '../../server/WebSocketServer.js';
import type { SessionProvider } from '../../server/WebSocketServer.js';
import type { Config } from '../../config.js';
import type { SessionInfo, SessionScreen, ServerMessage } from '../../types/protocol.js';
import { defaultSttConfig } from '../../stt/types.js';

let portCounter = 21000;

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
    graceDisconnectMs: 0,
    idleTimeoutMs: 300_000,
  };
}

function mockSessionProvider(): SessionProvider & {
  sessionState: 'running' | 'exited';
  restartCalls: string[];
  clientCount: number;
} {
  const sessions: SessionInfo[] = [
    { id: 'sess-1', name: 'main', state: 'running' },
  ];

  return {
    sessionState: 'running',
    restartCalls: [],
    clientCount: 0,
    listSessions() {
      sessions[0] = { id: 'sess-1', name: 'main', state: this.sessionState };
      return sessions;
    },
    getDefaultSessionId: () => 'sess-1',
    getLatestSnapshot: () => null,
    writeInput() {},
    writeRaw() {},
    sendSignal() {},
    resizeAll() {},
    clientConnected() { this.clientCount++; },
    clientDisconnected() { this.clientCount--; },
    restartSession(sessionId: string) {
      if (this.sessionState !== 'exited') {
        throw new Error(`Session ${sessionId} is still running`);
      }
      this.restartCalls.push(sessionId);
      this.sessionState = 'running';
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
      resolve({
        ws,
        messages,
        waitForMessage(predicate, timeoutMs = 2000) {
          const existing = messages.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timeout = setTimeout(() => rej(new Error('Timeout waiting for message')), timeoutMs);
            const check = (data: any) => {
              const msg = JSON.parse(data.toString());
              if (predicate(msg)) {
                clearTimeout(timeout);
                ws.off('message', check);
                res(msg);
              }
            };
            ws.on('message', check);
          });
        },
        send(msg: any) { ws.send(JSON.stringify(msg)); },
        close() { ws.close(); },
      });
    });
    ws.on('error', reject);
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });
  });
}

describe('SessionRestart integration', () => {
  let server: WebSocketServer;
  let provider: ReturnType<typeof mockSessionProvider>;
  let port: number;

  beforeEach(() => {
    port = portCounter++;
    provider = mockSessionProvider();
    server = new WebSocketServer(testConfig(port), provider);
    server.start();
  });

  afterEach(() => {
    server.stop();
  });

  it('restart exited session broadcasts session.restarted', async () => {
    provider.sessionState = 'exited';

    const c1 = await connectClient(port);
    c1.send({ type: 'client.hello', token: 'test-token', grid: { cols: 80, rows: 24 } });
    await c1.waitForMessage((m: any) => m.type === 'hello.ok');

    c1.send({ type: 'session.restart', sessionId: 'sess-1' });

    const restarted = await c1.waitForMessage((m: any) => m.type === 'session.restarted');
    expect((restarted as any).sessionId).toBe('sess-1');
    expect(provider.restartCalls).toEqual(['sess-1']);
    expect(provider.sessionState).toBe('running');

    c1.close();
  });

  it('restart running session returns error', async () => {
    provider.sessionState = 'running';

    const c1 = await connectClient(port);
    c1.send({ type: 'client.hello', token: 'test-token', grid: { cols: 80, rows: 24 } });
    await c1.waitForMessage((m: any) => m.type === 'hello.ok');

    c1.send({ type: 'session.restart', sessionId: 'sess-1' });

    const error = await c1.waitForMessage((m: any) => m.type === 'error');
    expect((error as any).code).toBe('SESSION_ERROR');

    c1.close();
  });

  it('restart requires operator', async () => {
    provider.sessionState = 'exited';

    // First client gets operator
    const c1 = await connectClient(port);
    c1.send({ type: 'client.hello', token: 'test-token', grid: { cols: 80, rows: 24 } });
    await c1.waitForMessage((m: any) => m.type === 'hello.ok');

    // Second client is viewer
    const c2 = await connectClient(port);
    c2.send({ type: 'client.hello', token: 'test-token', grid: { cols: 80, rows: 24 } });
    await c2.waitForMessage((m: any) => m.type === 'hello.ok');

    // Viewer tries to restart
    c2.send({ type: 'session.restart', sessionId: 'sess-1' });

    const error = await c2.waitForMessage((m: any) => m.type === 'error');
    expect((error as any).code).toBe('NOT_OPERATOR');

    c1.close();
    c2.close();
  });

  it('session.restarted broadcast to all clients', async () => {
    provider.sessionState = 'exited';

    const c1 = await connectClient(port);
    c1.send({ type: 'client.hello', token: 'test-token', grid: { cols: 80, rows: 24 } });
    await c1.waitForMessage((m: any) => m.type === 'hello.ok');

    const c2 = await connectClient(port);
    c2.send({ type: 'client.hello', token: 'test-token', grid: { cols: 80, rows: 24 } });
    await c2.waitForMessage((m: any) => m.type === 'hello.ok');

    // Operator restarts
    c1.send({ type: 'session.restart', sessionId: 'sess-1' });

    // Both clients should receive session.restarted
    const r1 = await c1.waitForMessage((m: any) => m.type === 'session.restarted');
    const r2 = await c2.waitForMessage((m: any) => m.type === 'session.restarted');
    expect((r1 as any).sessionId).toBe('sess-1');
    expect((r2 as any).sessionId).toBe('sess-1');

    c1.close();
    c2.close();
  });
});

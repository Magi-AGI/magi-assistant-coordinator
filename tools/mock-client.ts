/**
 * Mock client for manual testing without glasses.
 * Usage: MAGI_TOKEN=your-token tsx tools/mock-client.ts [ws://host:port]
 */
import WebSocket from 'ws';

const url = process.argv[2] || 'ws://localhost:9100';
const token = process.env.MAGI_TOKEN || 'change-me';

console.log(`Connecting to ${url}...`);
const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('Connected. Sending client.hello...');
  ws.send(JSON.stringify({
    type: 'client.hello',
    token,
    grid: { cols: 80, rows: 24 },
  }));
});

ws.on('message', (data: Buffer) => {
  const msg = JSON.parse(data.toString());

  switch (msg.type) {
    case 'hello.ok':
      console.log(`Authenticated. Sessions: ${msg.sessions.map((s: any) => s.name).join(', ')}`);
      console.log(`Active session: ${msg.activeSessionId}`);
      break;

    case 'session.screen':
      // Clear screen and render
      process.stdout.write('\x1B[2J\x1B[H');
      console.log(`── session: ${msg.sessionId} | seq: ${msg.seq} | v${msg.version} ──`);
      for (const line of msg.lines) {
        console.log(line);
      }
      console.log(`── cursor: (${msg.cursor.row},${msg.cursor.col}) | scrollback: ${msg.scrollback.totalLines} lines ──`);
      break;

    case 'session.list.result':
      console.log('Sessions:', JSON.stringify(msg.sessions, null, 2));
      break;

    case 'session.switched':
      console.log(`Switched to session: ${msg.sessionId}`);
      break;

    case 'error':
      console.error(`Error [${msg.code}]: ${msg.message}`);
      break;

    default:
      console.log('Unknown message:', msg);
  }
});

ws.on('close', (code: number, reason: Buffer) => {
  console.log(`Disconnected: ${code} ${reason.toString()}`);
  process.exit(0);
});

ws.on('error', (err: Error) => {
  console.error('Connection error:', err.message);
  process.exit(1);
});

// Handle stdin for interactive commands
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (key: Buffer) => {
  const char = key.toString();
  if (char === '\x03') { // Ctrl+C
    ws.close();
    process.exit(0);
  }
  if (char === 'l') {
    ws.send(JSON.stringify({ type: 'session.list' }));
  }
  if (char === 'n') {
    // Switch to next session (simple demo)
    ws.send(JSON.stringify({ type: 'session.list' }));
  }
});

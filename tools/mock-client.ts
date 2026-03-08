/**
 * Mock client for manual testing without glasses.
 * Usage: MAGI_TOKEN=your-token tsx tools/mock-client.ts [ws://host:port]
 *
 * Modes:
 *   Raw mode (default): single-key commands (l=list, n=next, Ctrl+C=quit)
 *   Line mode (press Enter in raw mode): type a command line, press Enter to send as session.input
 */
import WebSocket from 'ws';
import * as readline from 'readline';

const url = process.argv[2] || 'ws://localhost:9100';
const token = process.env.MAGI_TOKEN || 'change-me';

let activeSessionId = '';
let lineMode = false;

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
      activeSessionId = msg.activeSessionId;
      console.log(`Active session: ${activeSessionId}`);
      console.log('Press Enter to type a command, "l" to list sessions, "n" for next session, Ctrl+C to quit');
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
      activeSessionId = msg.sessionId;
      console.log(`Switched to session: ${activeSessionId}`);
      break;

    case 'input.accepted':
      console.log(`Input accepted [${msg.source}]: ${msg.text}`);
      break;

    case 'transcript':
      console.log(`Transcript [${msg.isFinal ? 'FINAL' : 'interim'}] (${msg.classification}, ${msg.confidence}): ${msg.text}`);
      break;

    case 'audio.stream.ready':
      console.log('Audio stream ready');
      break;

    case 'audio.stream.closed':
      console.log(`Audio stream closed: ${msg.reason}`);
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
    if (lineMode) {
      lineMode = false;
      console.log('\n(cancelled)');
      return;
    }
    ws.close();
    process.exit(0);
  }
  if (lineMode) return; // rl handles input in line mode

  if (char === '\r' || char === '\n') {
    // Enter line mode to type a command
    lineMode = true;
    process.stdin.setRawMode?.(false);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('cmd> ', (line) => {
      rl.close();
      lineMode = false;
      process.stdin.setRawMode?.(true);

      if (line.trim()) {
        ws.send(JSON.stringify({
          type: 'session.input',
          sessionId: activeSessionId,
          text: line.trim(),
          source: 'keyboard',
        }));
      }
    });
    return;
  }
  if (char === 'l') {
    ws.send(JSON.stringify({ type: 'session.list' }));
  }
  if (char === 'n') {
    ws.send(JSON.stringify({ type: 'session.list' }));
  }
  if (char === 'i') {
    // Send SIGINT
    ws.send(JSON.stringify({
      type: 'session.signal',
      sessionId: activeSessionId,
      signal: 'SIGINT',
    }));
    console.log('Sent SIGINT');
  }
});

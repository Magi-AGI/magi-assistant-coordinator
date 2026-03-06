import { loadConfig } from './config.js';
import { SessionManager } from './session/SessionManager.js';
import { WebSocketServer } from './server/WebSocketServer.js';

const config = loadConfig();

const sessionManager = new SessionManager(config);
const wsServer = new WebSocketServer(config, sessionManager);

// Wire snapshot broadcast: session → WebSocket clients
sessionManager.onSnapshot = (snapshot) => {
  wsServer.broadcastSnapshot(snapshot);
};

// Start
sessionManager.startAll();
wsServer.start();

// Graceful shutdown
function shutdown() {
  console.log('\n[main] Shutting down...');
  wsServer.stop();
  sessionManager.stopAll();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[main] Magi Coordinator ready on port ${config.port}`);

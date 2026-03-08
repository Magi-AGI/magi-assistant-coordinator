import { loadConfig } from './config.js';
import { SessionManager } from './session/SessionManager.js';
import { WebSocketServer } from './server/WebSocketServer.js';
import { SttBridge } from './stt/SttBridge.js';
import { CommandClassifier } from './classify/CommandClassifier.js';

const config = loadConfig();

const sessionManager = new SessionManager(config);
const wsServer = new WebSocketServer(config, sessionManager);

// Phase 1: STT + Command Classification
const sttBridge = new SttBridge(config.stt);
const classifier = new CommandClassifier(
  config.classification.denyPatterns,
  config.classification.confirmPatterns,
);
wsServer.setSttBridge(sttBridge);
wsServer.setClassifier(classifier);

// Wire snapshot broadcast: session → WebSocket clients
sessionManager.onSnapshot = (snapshot) => {
  wsServer.broadcastSnapshot(snapshot);
};

// Start
async function start() {
  await sttBridge.init();
  sessionManager.startAll();
  wsServer.start();
  console.log(`[main] Magi Coordinator ready on port ${config.port}`);
  if (sttBridge.available) {
    console.log('[main] Voice input: enabled');
  } else {
    console.log('[main] Voice input: disabled (text input only)');
  }
}

start().catch(err => {
  console.error('[main] Failed to start:', err);
  process.exit(1);
});

// Graceful shutdown
async function shutdown() {
  console.log('\n[main] Shutting down...');
  wsServer.stop();
  sessionManager.stopAll();
  await sttBridge.dispose();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

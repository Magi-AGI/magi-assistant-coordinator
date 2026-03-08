import 'dotenv/config';
import type { SttConfig } from './stt/types.js';
import { defaultSttConfig } from './stt/types.js';

export interface SessionConfig {
  id: string;
  name: string;
  shell: string;
  args: string[];
  cwd: string;
}

export interface ClassificationConfig {
  denyPatterns?: string[];
  confirmPatterns?: string[];
  autoSendConfidence: number;
}

export interface Config {
  port: number;
  token: string;
  sessions: SessionConfig[];
  logLevel: string;
  // Tuning
  maxSessions: number;
  defaultCols: number;
  defaultRows: number;
  scrollback: number;
  fpsCap: number;
  debounceMs: number;
  renderBudgetMs: number;
  backpressureBytes: number;
  // Phase 1
  stt: SttConfig;
  classification: ClassificationConfig;
}

export function loadConfig(): Config {
  const token = process.env.MAGI_TOKEN;
  if (!token) {
    console.error('MAGI_TOKEN is required. Set it in .env or environment.');
    process.exit(1);
  }

  let sessions: SessionConfig[] = [];
  const sessionsRaw = process.env.MAGI_SESSIONS;
  if (sessionsRaw) {
    try {
      sessions = JSON.parse(sessionsRaw);
    } catch {
      console.error('MAGI_SESSIONS must be valid JSON array');
      process.exit(1);
    }
  }

  // Build STT config from env vars
  const stt = defaultSttConfig();
  if (process.env.MAGI_STT_ENABLED === 'true') {
    stt.enabled = true;
    stt.googleCloud.projectId = process.env.MAGI_STT_PROJECT_ID || '';
    stt.googleCloud.keyFile = process.env.MAGI_STT_KEY_FILE || '';
    stt.googleCloud.model = process.env.MAGI_STT_MODEL || 'latest_long';
    stt.googleCloud.languageCode = process.env.MAGI_STT_LANGUAGE || 'en-US';
    if (process.env.MAGI_STT_PHRASE_HINTS) {
      stt.googleCloud.phraseHints = process.env.MAGI_STT_PHRASE_HINTS.split(',');
    }
  }

  return {
    port: parseInt(process.env.MAGI_PORT || '9100', 10),
    token,
    sessions,
    logLevel: process.env.MAGI_LOG_LEVEL || 'info',
    maxSessions: 10,
    defaultCols: 80,
    defaultRows: 24,
    scrollback: 5000,
    fpsCap: 10,
    debounceMs: 50,
    renderBudgetMs: 10,
    backpressureBytes: 1024 * 1024, // 1MB
    stt,
    classification: {
      autoSendConfidence: parseFloat(process.env.MAGI_AUTO_SEND_CONFIDENCE || '0.9'),
    },
  };
}

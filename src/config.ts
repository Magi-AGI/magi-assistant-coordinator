import 'dotenv/config';

export interface SessionConfig {
  id: string;
  name: string;
  shell: string;
  args: string[];
  cwd: string;
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
  };
}

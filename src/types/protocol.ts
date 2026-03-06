// ── Client → Coordinator ──

export interface ClientHello {
  type: 'client.hello';
  token: string;
  grid: { cols: number; rows: number };
  resumeFromSeq?: number;
}

export interface SessionListRequest {
  type: 'session.list';
}

export interface SessionSwitch {
  type: 'session.switch';
  sessionId: string;
}

export interface ClientGrid {
  type: 'client.grid';
  cols: number;
  rows: number;
}

export type ClientMessage =
  | ClientHello
  | SessionListRequest
  | SessionSwitch
  | ClientGrid;

// ── Coordinator → Client ──

export interface SessionInfo {
  id: string;
  name: string;
  state: 'running' | 'exited';
}

export interface HelloOk {
  type: 'hello.ok';
  sessions: SessionInfo[];
  activeSessionId: string;
}

export interface SessionScreen {
  type: 'session.screen';
  sessionId: string;
  lines: string[];
  version: number;
  cursor: { row: number; col: number };
  seq: number;
  scrollback: { totalLines: number; viewportRow: number };
}

export interface SessionListResult {
  type: 'session.list.result';
  sessions: SessionInfo[];
}

export interface SessionSwitched {
  type: 'session.switched';
  sessionId: string;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type ServerMessage =
  | HelloOk
  | SessionScreen
  | SessionListResult
  | SessionSwitched
  | ErrorMessage;

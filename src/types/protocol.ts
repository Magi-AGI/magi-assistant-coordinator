// ── Client → Coordinator ──

export type DeviceType = 'glasses' | 'phone';
export type Role = 'operator' | 'viewer';

export interface ClientHello {
  type: 'client.hello';
  token: string;
  grid: { cols: number; rows: number };
  resumeFromSeq?: number;
  deviceType?: DeviceType; // default 'glasses' for backward compat
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

export interface SessionInput {
  type: 'session.input';
  sessionId: string;
  text: string;
  source: 'voice' | 'keyboard';
}

export interface SessionSignal {
  type: 'session.signal';
  sessionId: string;
  signal: 'SIGINT' | 'SIGKILL';
}

export interface AudioStreamStart {
  type: 'audio.stream.start';
  sessionId: string;
  sampleRate: number;
  encoding: string;
}

export interface AudioChunk {
  type: 'audio.chunk';
  data: string; // base64-encoded PCM
  seq: number;
}

export interface AudioStreamEnd {
  type: 'audio.stream.end';
}

export interface InputConfirm {
  type: 'input.confirm';
  transcriptSeq: number;
  action: 'send' | 'cancel';
}

export interface RoleClaim {
  type: 'role.claim';
  force: boolean;
}

export interface SessionRaw {
  type: 'session.raw';
  sessionId: string;
  data: string; // raw bytes to send to PTY (no \n appended)
}

export type ClientMessage =
  | ClientHello
  | SessionListRequest
  | SessionSwitch
  | ClientGrid
  | SessionInput
  | SessionSignal
  | AudioStreamStart
  | AudioChunk
  | AudioStreamEnd
  | InputConfirm
  | RoleClaim
  | SessionRaw;

// ── Coordinator → Client ──

export interface SessionInfo {
  id: string;
  name: string;
  state: 'running' | 'exited';
}

export interface ClientInfo {
  id: string;
  deviceType: DeviceType;
  role: Role;
}

export interface HelloOk {
  type: 'hello.ok';
  sessions: SessionInfo[];
  activeSessionId: string;
  role: Role;
  clients: ClientInfo[];
  roleVersion: number;
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

export interface InputAccepted {
  type: 'input.accepted';
  sessionId: string;
  text: string;
  source: 'voice' | 'keyboard';
}

export interface AudioStreamReady {
  type: 'audio.stream.ready';
}

export interface Transcript {
  type: 'transcript';
  text: string;
  confidence: number;
  isFinal: boolean;
  seq: number;
  classification: 'safe' | 'confirm' | 'deny';
}

export interface AudioStreamClosed {
  type: 'audio.stream.closed';
  reason: 'end' | 'error' | 'timeout';
}

export interface RoleGranted {
  type: 'role.granted';
  role: Role;
  roleVersion: number;
}

export interface RoleRevoked {
  type: 'role.revoked';
  newRole: Role;
  reason: string;
  roleVersion: number;
}

export interface ClientJoined {
  type: 'client.joined';
  clientId: string;
  deviceType: DeviceType;
  role: Role;
}

export interface ClientLeft {
  type: 'client.left';
  clientId: string;
}

export interface SignalAccepted {
  type: 'signal.accepted';
  sessionId: string;
  signal: 'SIGINT' | 'SIGKILL';
}

export interface SessionExited {
  type: 'session.exited';
  sessionId: string;
  exitCode: number;
}

export type ServerMessage =
  | HelloOk
  | SessionScreen
  | SessionListResult
  | SessionSwitched
  | ErrorMessage
  | InputAccepted
  | AudioStreamReady
  | Transcript
  | AudioStreamClosed
  | RoleGranted
  | RoleRevoked
  | ClientJoined
  | ClientLeft
  | SignalAccepted
  | SessionExited;

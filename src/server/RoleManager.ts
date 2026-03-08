import type { ClientConnection } from './ClientConnection.js';
import type { ClientInfo } from '../types/protocol.js';

export interface RoleTransferEvent {
  from: string | null;
  to: string;
  reason: 'first_connect' | 'claim' | 'force_claim' | 'phone_priority' | 'auto_promote' | 'disconnect';
  force: boolean;
  timestamp: number;
}

/**
 * Manages operator/viewer roles across connected clients.
 *
 * Rules:
 * - First authenticated client → operator automatically
 * - role.claim with force: true → always succeeds
 * - role.claim from phone against glasses operator → succeeds (phone priority)
 * - role.claim from glasses against phone operator → requires force: true
 * - Operator disconnects → grace period before auto-promoting (configurable, default 5s)
 * - roleVersion increments on every role change to prevent stale events
 */
export class RoleManager {
  private operatorId: string | null = null;
  private clients = new Map<string, ClientConnection>();
  private _roleVersion = 0;
  private _onTransfer: ((event: RoleTransferEvent) => void) | null = null;

  // Grace disconnect — deferred auto-promote
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private _onAutoPromote: ((promoted: ClientConnection) => void) | null = null;

  constructor(private readonly graceMs: number = 5000) {}

  get roleVersion(): number {
    return this._roleVersion;
  }

  set onTransfer(cb: ((event: RoleTransferEvent) => void) | null) {
    this._onTransfer = cb;
  }

  set onAutoPromote(cb: ((promoted: ClientConnection) => void) | null) {
    this._onAutoPromote = cb;
  }

  /** Register a newly authenticated client. Returns assigned role. */
  addClient(client: ClientConnection): 'operator' | 'viewer' {
    this.clients.set(client.id, client);

    if (this.operatorId === null) {
      // No operator — this client gets it (handles both first-connect and grace-period reconnect)
      this.cancelGrace();
      this.operatorId = client.id;
      client.role = 'operator';
      this._roleVersion++;
      this.logTransfer(null, client.id, 'first_connect', false);
      return 'operator';
    }

    client.role = 'viewer';
    return 'viewer';
  }

  /** Handle a role.claim request. Returns true if claim succeeded. */
  claimOperator(claimant: ClientConnection, force: boolean): boolean {
    if (this.operatorId === claimant.id) {
      // Already operator
      return true;
    }

    const currentOperator = this.operatorId ? this.clients.get(this.operatorId) : null;

    // Determine if claim succeeds
    let allowed = false;
    let reason: RoleTransferEvent['reason'] = 'claim';

    if (force) {
      allowed = true;
      reason = 'force_claim';
    } else if (!currentOperator) {
      // No current operator (e.g., during grace period)
      allowed = true;
      reason = 'claim';
    } else if (claimant.deviceType === 'phone' && currentOperator.deviceType === 'glasses') {
      // Phone priority: phone can always take from glasses
      allowed = true;
      reason = 'phone_priority';
    } else {
      // Glasses trying to take from phone without force → denied
      allowed = false;
    }

    if (!allowed) {
      return false;
    }

    // Cancel any grace timer since we're assigning a new operator
    this.cancelGrace();

    const previousOperatorId = this.operatorId;

    // Revoke from current operator
    if (currentOperator) {
      currentOperator.role = 'viewer';
    }

    // Grant to claimant
    this.operatorId = claimant.id;
    claimant.role = 'operator';
    this._roleVersion++;

    this.logTransfer(previousOperatorId, claimant.id, reason, force);

    return true;
  }

  /** Handle client disconnect. Returns auto-promoted client if any (only when graceMs=0). */
  removeClient(clientId: string): ClientConnection | null {
    this.clients.delete(clientId);

    if (this.operatorId !== clientId) {
      return null; // Viewer left, no role change
    }

    // Operator left — defer auto-promote with grace timer
    this.operatorId = null;

    if (this.clients.size === 0) {
      return null;
    }

    if (this.graceMs > 0) {
      // Start grace timer — deferred auto-promote
      this.cancelGrace();
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        const promoted = this.doAutoPromote(clientId);
        if (promoted) {
          this._onAutoPromote?.(promoted);
        }
      }, this.graceMs);
      return null;
    }

    // Instant auto-promote (graceMs=0, preserves existing test behavior)
    return this.doAutoPromote(clientId);
  }

  /** Perform auto-promote logic. Returns promoted client or null. */
  private doAutoPromote(disconnectedId: string): ClientConnection | null {
    if (this.operatorId !== null) return null; // Already has operator (e.g., reconnected during grace)
    if (this.clients.size === 0) return null;

    // Prefer phone for auto-promote, else first remaining client
    let promoted: ClientConnection | null = null;
    for (const client of this.clients.values()) {
      if (client.deviceType === 'phone') {
        promoted = client;
        break;
      }
    }
    if (!promoted) {
      promoted = this.clients.values().next().value ?? null;
    }

    if (promoted) {
      this.operatorId = promoted.id;
      promoted.role = 'operator';
      this._roleVersion++;
      this.logTransfer(disconnectedId, promoted.id, 'auto_promote', false);
    }

    return promoted;
  }

  /** Cancel the grace timer (for cleanup/shutdown). */
  cancelGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /** Check if a client is the current operator. */
  isOperator(clientId: string): boolean {
    return this.operatorId === clientId;
  }

  /** Check if there is currently no operator (e.g., during grace period). */
  hasNoOperator(): boolean {
    return this.operatorId === null;
  }

  /** Get info about all connected clients for hello.ok. */
  getClientInfos(): ClientInfo[] {
    return Array.from(this.clients.values()).map(c => ({
      id: c.id,
      deviceType: c.deviceType,
      role: c.role,
    }));
  }

  /** Get all connected clients. */
  getAllClients(): ClientConnection[] {
    return Array.from(this.clients.values());
  }

  private logTransfer(from: string | null, to: string, reason: RoleTransferEvent['reason'], force: boolean): void {
    const event: RoleTransferEvent = { from, to, reason, force, timestamp: Date.now() };
    console.log(`[role] Transfer: ${from ?? 'none'} → ${to} (${reason}${force ? ', forced' : ''}) v${this._roleVersion}`);
    this._onTransfer?.(event);
  }
}

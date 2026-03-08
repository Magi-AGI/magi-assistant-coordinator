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
 * - Operator disconnects → next client auto-promoted (phone preferred)
 * - roleVersion increments on every role change to prevent stale events
 */
export class RoleManager {
  private operatorId: string | null = null;
  private clients = new Map<string, ClientConnection>();
  private _roleVersion = 0;
  private _onTransfer: ((event: RoleTransferEvent) => void) | null = null;

  get roleVersion(): number {
    return this._roleVersion;
  }

  set onTransfer(cb: ((event: RoleTransferEvent) => void) | null) {
    this._onTransfer = cb;
  }

  /** Register a newly authenticated client. Returns assigned role. */
  addClient(client: ClientConnection): 'operator' | 'viewer' {
    this.clients.set(client.id, client);

    if (this.operatorId === null) {
      // First client gets operator
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
      // No current operator
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

  /** Handle client disconnect. Returns auto-promoted client if any. */
  removeClient(clientId: string): ClientConnection | null {
    this.clients.delete(clientId);

    if (this.operatorId !== clientId) {
      return null; // Viewer left, no role change
    }

    // Operator left — auto-promote
    this.operatorId = null;

    if (this.clients.size === 0) {
      return null;
    }

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
      this.logTransfer(clientId, promoted.id, 'auto_promote', false);
    }

    return promoted;
  }

  /** Check if a client is the current operator. */
  isOperator(clientId: string): boolean {
    return this.operatorId === clientId;
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

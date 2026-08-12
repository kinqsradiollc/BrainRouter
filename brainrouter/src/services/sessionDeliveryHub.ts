/**
 * ADR-034 remote wake routing for durable session inbox rows.
 *
 * Authentication and persistence happen before this service is called. The
 * hub binds one authenticated MCP connection to each live `(user, session)`
 * identity and emits only message-id wake hints; the database inbox remains
 * the source of truth and polling remains the reconnect fallback.
 */
import type { SessionInboxRecord, SessionMessageStoreNotification } from '@kinqs/brainrouter-types';
import type { SessionMessageWake } from '@kinqs/brainrouter-core/mcp';

export interface SessionDeliveryBinding {
  connectionId: string;
  orgId: string | null;
  userId: string;
  sessionKey: string;
  notify?: (wake: SessionMessageWake) => Promise<void>;
}

interface ReservedSessionDeliveryBinding extends SessionDeliveryBinding {
  /** Present only while the first registration attempt owns this placeholder. */
  reservationAttemptId?: string;
}

interface SessionDeliveryReservation {
  connectionId: string;
  registrationAttemptId: string;
}

export type SessionWakeOutcome = 'pushed' | 'poll-fallback';
export type SessionDeliveryClaimValidator = (
  binding: SessionDeliveryBinding,
) => boolean | Promise<boolean>;

function address(orgId: string | null | undefined, userId: string, sessionKey: string): string {
  return `${orgId ?? ''}\u0000${userId}\u0000${sessionKey}`;
}

export class SessionDeliveryHub {
  private readonly byAddress = new Map<string, ReservedSessionDeliveryBinding>();
  private readonly addressesByConnection = new Map<string, Set<string>>();
  /**
   * Every registration attempt, including a re-registration of an already
   * committed route, owns an exact finalize token. Keeping this separate from
   * `byAddress` lets the existing committed route remain usable during its
   * metadata refresh without allowing concurrent/stale completions.
   */
  private readonly reservationsByAddress = new Map<string, SessionDeliveryReservation>();

  bind(binding: SessionDeliveryBinding): void {
    const key = address(binding.orgId, binding.userId, binding.sessionKey);
    const previous = this.byAddress.get(key);
    if (previous) this.unlinkConnectionAddress(previous.connectionId, key);
    this.reservationsByAddress.delete(key);
    this.byAddress.set(key, binding);
    const owned = this.addressesByConnection.get(binding.connectionId) ?? new Set<string>();
    owned.add(key);
    this.addressesByConnection.set(binding.connectionId, owned);
  }

  owns(connectionId: string, orgId: string | null, userId: string, sessionKey: string): boolean {
    const binding = this.byAddress.get(address(orgId, userId, sessionKey));
    return binding?.connectionId === connectionId && binding.reservationAttemptId === undefined;
  }

  canClaim(connectionId: string, orgId: string | null, userId: string, sessionKey: string): boolean {
    const binding = this.byAddress.get(address(orgId, userId, sessionKey));
    return !binding || binding.connectionId === connectionId;
  }

  /** Atomically reserve an address across awaits in the registration handler. */
  reserve(
    connectionId: string,
    orgId: string | null,
    userId: string,
    sessionKey: string,
    registrationAttemptId: string,
  ): boolean {
    const key = address(orgId, userId, sessionKey);
    const binding = this.byAddress.get(key);
    if (binding && binding.connectionId !== connectionId) return false;
    const reservation = this.reservationsByAddress.get(key);
    if (reservation) {
      return reservation.connectionId === connectionId
        && reservation.registrationAttemptId === registrationAttemptId;
    }
    this.reservationsByAddress.set(key, { connectionId, registrationAttemptId });
    if (!binding) {
      this.byAddress.set(key, {
        connectionId,
        orgId,
        userId,
        sessionKey,
        reservationAttemptId: registrationAttemptId,
      });
      const owned = this.addressesByConnection.get(connectionId) ?? new Set<string>();
      owned.add(key);
      this.addressesByConnection.set(connectionId, owned);
    }
    return true;
  }

  /**
   * Promote only the exact reservation that survived the asynchronous database
   * registration. A disconnected/stale attempt must never replace a newer live
   * owner that claimed the address while the original request was in flight.
   */
  commitReservation(
    binding: SessionDeliveryBinding,
    registrationAttemptId: string,
  ): boolean {
    const key = address(binding.orgId, binding.userId, binding.sessionKey);
    const reserved = this.byAddress.get(key);
    const reservation = this.reservationsByAddress.get(key);
    if (
      !reserved
      || reserved.connectionId !== binding.connectionId
      || reservation?.connectionId !== binding.connectionId
      || reservation.registrationAttemptId !== registrationAttemptId
    ) return false;

    this.reservationsByAddress.delete(key);
    this.byAddress.set(key, binding);
    const owned = this.addressesByConnection.get(binding.connectionId) ?? new Set<string>();
    owned.add(key);
    this.addressesByConnection.set(binding.connectionId, owned);
    return true;
  }

  /** Roll back only the placeholder created by this exact failed attempt. */
  releaseReservation(
    connectionId: string,
    orgId: string | null,
    userId: string,
    sessionKey: string,
    registrationAttemptId: string,
  ): void {
    const key = address(orgId, userId, sessionKey);
    const binding = this.byAddress.get(key);
    const reservation = this.reservationsByAddress.get(key);
    if (
      reservation?.connectionId !== connectionId
      || reservation.registrationAttemptId !== registrationAttemptId
    ) return;
    this.reservationsByAddress.delete(key);
    if (
      binding?.connectionId === connectionId
      && binding.reservationAttemptId === registrationAttemptId
    ) {
      this.byAddress.delete(key);
      this.unlinkConnectionAddress(connectionId, key);
    }
  }

  unbind(orgId: string | null, userId: string, sessionKey: string, connectionId?: string): void {
    const key = address(orgId, userId, sessionKey);
    const binding = this.byAddress.get(key);
    if (!binding || (connectionId && binding.connectionId !== connectionId)) return;
    this.byAddress.delete(key);
    const reservation = this.reservationsByAddress.get(key);
    if (!connectionId || reservation?.connectionId === connectionId) {
      this.reservationsByAddress.delete(key);
    }
    this.unlinkConnectionAddress(binding.connectionId, key);
  }

  disconnect(connectionId: string): void {
    const addresses = this.addressesByConnection.get(connectionId);
    if (!addresses) return;
    for (const key of addresses) {
      const binding = this.byAddress.get(key);
      if (binding?.connectionId === connectionId) this.byAddress.delete(key);
      const reservation = this.reservationsByAddress.get(key);
      if (reservation?.connectionId === connectionId) this.reservationsByAddress.delete(key);
    }
    this.addressesByConnection.delete(connectionId);
  }

  async notifyPersisted(
    records: SessionInboxRecord[],
    validateClaim?: SessionDeliveryClaimValidator,
  ): Promise<Map<string, SessionWakeOutcome>> {
    const outcomes = new Map<string, SessionWakeOutcome>();
    const groups = new Map<string, SessionInboxRecord[]>();
    for (const record of records) {
      const key = address(record.orgId, record.userId, record.toSessionKey);
      const group = groups.get(key);
      if (group) group.push(record);
      else groups.set(key, [record]);
      outcomes.set(record.id, 'poll-fallback');
    }

    await Promise.all([...groups.entries()].map(async ([key, group]) => {
      const binding = this.byAddress.get(key);
      if (!binding?.notify) return;
      if (!await this.isCurrentClaim(binding, validateClaim)) {
        this.unbind(binding.orgId, binding.userId, binding.sessionKey, binding.connectionId);
        return;
      }
      try {
        await binding.notify({
          sessionKey: binding.sessionKey,
          messageIds: group.map((record) => record.id),
        });
        for (const record of group) outcomes.set(record.id, 'pushed');
      } catch {
        // A dead stream is no longer authoritative. The durable rows remain for
        // the recipient's next poll/reconnect and this binding is reaped now.
        this.disconnect(binding.connectionId);
      }
    }));

    return outcomes;
  }

  /** Route a committed cross-process database hint to the relevant live stream. */
  async notifyStoreNotification(
    notification: SessionMessageStoreNotification,
    validateClaim?: SessionDeliveryClaimValidator,
  ): Promise<SessionWakeOutcome> {
    const recipientSessionKey = notification.status === 'pending'
      ? notification.toSessionKey
      : notification.fromSessionKey;
    const binding = this.byAddress.get(address(
      notification.orgId,
      notification.userId,
      recipientSessionKey,
    ));
    if (!binding?.notify) return 'poll-fallback';
    if (!await this.isCurrentClaim(binding, validateClaim)) {
      this.unbind(binding.orgId, binding.userId, binding.sessionKey, binding.connectionId);
      return 'poll-fallback';
    }
    try {
      await binding.notify({
        sessionKey: recipientSessionKey,
        messageIds: [notification.inboxId],
      });
      return 'pushed';
    } catch {
      this.disconnect(binding.connectionId);
      return 'poll-fallback';
    }
  }

  private unlinkConnectionAddress(connectionId: string, key: string): void {
    const owned = this.addressesByConnection.get(connectionId);
    if (!owned) return;
    owned.delete(key);
    if (owned.size === 0) this.addressesByConnection.delete(connectionId);
  }

  private async isCurrentClaim(
    binding: SessionDeliveryBinding,
    validateClaim: SessionDeliveryClaimValidator | undefined,
  ): Promise<boolean> {
    if (!validateClaim) return true;
    try {
      return await validateClaim(binding);
    } catch {
      // A database ownership check that cannot complete must never authorize an
      // ephemeral push. The durable inbox remains available after reconnect.
      return false;
    }
  }
}

export const sessionDeliveryHub = new SessionDeliveryHub();

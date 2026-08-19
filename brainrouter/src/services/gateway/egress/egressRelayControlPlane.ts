import type { RemoteRelayTicketRecord } from "../../../remote/store.js";
import {
  EgressTicketRegistry,
  isReservedOriginDeviceId,
  type EgressTicketRole,
} from "./egressTicket.js";

/**
 * ADR-043 S3b (C1) — adapt the in-process {@link EgressTicketRegistry} into the
 * `consumeRelayTicket` shape a {@link RemoteRelayServer} expects, so an
 * UNMODIFIED relay server (stood up on the dedicated `/egress-relay` path) can
 * pair and opaquely splice an egress `origin ↔ client` leg. The relay never sees
 * the dial target or the credential — it only splices ciphertext between the two
 * paired seats, exactly as it does for device pairing.
 *
 * Trust root: the role is derived from the PRESENTED deviceId, never the token —
 * an `origin:`-prefixed device is the gateway seat, anything else is the client
 * seat. `redeem` then enforces single-use, expiry, and exact role/deviceId
 * binding, so a client presenting an `origin:` id, a mismatched-role token, an
 * expired token, or a replayed token all fail closed (null → the relay closes
 * the socket with `invalidTicket`).
 *
 * Store separation (egressTicket.ts's stated invariant): egress tickets live in
 * this in-process registry, NEVER in the DB-backed remote-relay ticket store, so
 * an egress token can never redeem as a pairing capability or vice-versa.
 */
export class EgressRelayControlPlane {
  readonly #registry: EgressTicketRegistry;
  readonly #now: () => number;

  constructor(registry: EgressTicketRegistry, options: { now?: () => number } = {}) {
    this.#registry = registry;
    this.#now = options.now ?? Date.now;
  }

  async consumeRelayTicket(
    ticket: string,
    presentingDeviceId: string,
  ): Promise<RemoteRelayTicketRecord | null> {
    const role: EgressTicketRole = isReservedOriginDeviceId(presentingDeviceId) ? "origin" : "client";
    const redemption = this.#registry.redeem(ticket, role, presentingDeviceId);
    if (!redemption) return null;

    const iso = new Date(this.#now()).toISOString();
    return {
      id: redemption.sessionId,
      orgId: redemption.identity.orgId,
      userId: redemption.identity.userId,
      presentingDeviceId,
      peerDeviceId: redemption.peerDeviceId,
      // Pair key = sessionId: the relay only ever splices the two seats of ONE
      // egress session, so a splice can never cross sessions or users (§7 #3).
      grantId: redemption.sessionId,
      sessionFamilyId: redemption.sessionId,
      audience: "remote-relay",
      // Egress tickets carry NO remote-access scopes (monitor/control/approve):
      // they authorize exactly one opaque splice and nothing else.
      scopes: [],
      // The registry already enforced expiry/single-use at redeem time; these
      // metadata fields satisfy the record shape and are not re-checked by the
      // relay (it trusts consumeRelayTicket as the authority).
      expiresAt: iso,
      consumedAt: iso,
      revokedAt: null,
      revocationReason: null,
      createdAt: iso,
    };
  }
}

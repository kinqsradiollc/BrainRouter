import { createHash, randomBytes } from 'node:crypto';
import type { EgressDialTarget } from './tunnelTransport.js';

/**
 * ADR-043 S3b — egress tunnel tickets.
 *
 * The gateway dials a provider *through* the user's edge by splicing over the
 * remote-relay's proven two-endpoint channel (ADR-043 D6). To attach that
 * channel we mint a single-use ticket PAIR under a dedicated egress path —
 * kept entirely separate from device-pairing tickets so an egress ticket can
 * never redeem as a pairing capability or vice-versa (seam-author review (b):
 * physical separation is a stronger boundary than an audience flag on a shared
 * table).
 *
 * Security model (seam-author review (a)/(b)/(c) + reinforcements):
 *  - The target host:port is the SERVER-validated upstream, bound into the pair
 *    at issuance; the client is TOLD where to dial and can never name the host
 *    — the SSRF boundary. The caller MUST pass a `validateUpstreamTarget`-checked
 *    target; this binds, it does not re-validate. (a)
 *  - Origin and client tokens are distinct opaque secrets; the origin token is
 *    gateway-held and NEVER sent to the client. (b)
 *  - `origin:` is a reserved, server-mint-only device namespace: a client can
 *    never present an `origin:*` id at redemption; enrolled device ids never
 *    carry the prefix. (reinforcement #1)
 *  - Tight TTL, single-use on BOTH halves — a redeemed or expired ticket is
 *    dead. A leaked ticket is at worst a one-shot, time-boxed tunnel to an
 *    already-allowlisted host. (reinforcements #2, #3)
 */

export const EGRESS_TICKET_AUDIENCE = 'egress-tunnel' as const;
export const ORIGIN_DEVICE_PREFIX = 'origin:' as const;
/** Tight single-use lifetime — short enough that a stale bound target cannot be redeemed. */
export const DEFAULT_EGRESS_TICKET_TTL_SECONDS = 20;

export type EgressTicketRole = 'origin' | 'client';

/** The per-request identity an egress session is keyed to (one-user rule, (c)). */
export interface EgressSessionIdentity {
  readonly orgId: string;
  readonly userId: string;
  /** The enrolled client device that relays this user's own traffic. */
  readonly clientDeviceId: string;
  /** The per-key identity the S1 rate-shaper shards on — the tunnel is keyed to it. */
  readonly upstreamKeyId: string;
}

/** One half of a ticket pair — what an endpoint presents to attach the channel. */
export interface EgressTicketGrant {
  /** Opaque secret, returned once. The origin grant is gateway-held, never client-visible. */
  readonly token: string;
  readonly role: EgressTicketRole;
  readonly presentingDeviceId: string;
  readonly peerDeviceId: string;
}

export interface EgressTicketPair {
  readonly sessionId: string;
  readonly origin: EgressTicketGrant;
  readonly client: EgressTicketGrant;
  /** Server-validated, bound at issuance. The dial instruction uses exactly this. */
  readonly target: EgressDialTarget;
  readonly expiresAt: string;
}

/** What a successful redemption yields: where to dial and who the peer is. */
export interface EgressTicketRedemption {
  readonly sessionId: string;
  readonly role: EgressTicketRole;
  readonly peerDeviceId: string;
  readonly target: EgressDialTarget;
  readonly identity: EgressSessionIdentity;
}

/** True for any id in the reserved, server-mint-only origin namespace. */
export function isReservedOriginDeviceId(deviceId: string): boolean {
  return deviceId.startsWith(ORIGIN_DEVICE_PREFIX);
}

function hashTokenHex(token: string): string {
  return createHash('sha256').update('brainrouter:egress-ticket:v1', 'utf8').update('\0').update(token).digest('hex');
}

interface StoredGrant {
  readonly sessionId: string;
  readonly role: EgressTicketRole;
  readonly presentingDeviceId: string;
  readonly peerDeviceId: string;
  readonly target: EgressDialTarget;
  readonly identity: EgressSessionIdentity;
  readonly expiresAtMs: number;
  consumed: boolean;
}

export interface EgressTicketRegistryOptions {
  now?: () => number;
  random?: (size: number) => Buffer;
  ttlSeconds?: number;
}

/**
 * ADR-043 S3b — single-use egress ticket issuance + redemption, keyed to one
 * user's identity. In-process (matching the relay's sticky-by-grant, in-process
 * pairing state); a store-backed variant for cross-instance durability/revocation
 * is a hardening follow-up, not a correctness gap for the single-node default.
 *
 * The token is the capability, indexed by its salted hash (as the relay's
 * ticket store does); role + presenting-device bindings are additional checks
 * on top so a token alone cannot be replayed in the wrong seat.
 */
export class EgressTicketRegistry {
  readonly #grants = new Map<string, StoredGrant>();
  readonly #now: () => number;
  readonly #random: (size: number) => Buffer;
  readonly #ttlSeconds: number;

  constructor(options: EgressTicketRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? randomBytes;
    this.#ttlSeconds = options.ttlSeconds ?? DEFAULT_EGRESS_TICKET_TTL_SECONDS;
    if (this.#ttlSeconds < 5 || this.#ttlSeconds > 60) {
      throw new Error('Egress ticket TTL must be between 5 and 60 seconds (tight single-use).');
    }
  }

  /**
   * Mint an origin+client ticket pair for one dial to `target` (which the caller
   * MUST have run through `validateUpstreamTarget`). A real client device id may
   * never be reserved.
   */
  issue(target: EgressDialTarget, identity: EgressSessionIdentity): EgressTicketPair {
    if (isReservedOriginDeviceId(identity.clientDeviceId)) {
      throw new Error('An enrolled client device id may not use the reserved "origin:" namespace.');
    }
    const sessionId = this.#random(16).toString('base64url');
    const originId = `${ORIGIN_DEVICE_PREFIX}${sessionId}`;
    const originToken = `egt_${this.#random(32).toString('base64url')}`;
    const clientToken = `egt_${this.#random(32).toString('base64url')}`;
    const expiresAtMs = this.#now() + this.#ttlSeconds * 1000;
    const common = { sessionId, target, identity, expiresAtMs, consumed: false };

    this.#grants.set(hashTokenHex(originToken), {
      ...common, role: 'origin', presentingDeviceId: originId, peerDeviceId: identity.clientDeviceId,
    });
    this.#grants.set(hashTokenHex(clientToken), {
      ...common, role: 'client', presentingDeviceId: identity.clientDeviceId, peerDeviceId: originId,
    });

    return {
      sessionId,
      target,
      expiresAt: new Date(expiresAtMs).toISOString(),
      origin: { token: originToken, role: 'origin', presentingDeviceId: originId, peerDeviceId: identity.clientDeviceId },
      client: { token: clientToken, role: 'client', presentingDeviceId: identity.clientDeviceId, peerDeviceId: originId },
    };
  }

  /**
   * Redeem one half exactly once. Returns null on any mismatch — unknown/expired
   * token, wrong role, already-consumed, a presenter that does not match the
   * grant's bound id, or a client presenting a reserved origin id.
   */
  redeem(token: string, role: EgressTicketRole, presentingDeviceId: string): EgressTicketRedemption | null {
    if (role === 'client' && isReservedOriginDeviceId(presentingDeviceId)) return null;

    const grant = this.#grants.get(hashTokenHex(token));
    if (!grant) return null;
    if (grant.consumed || grant.expiresAtMs <= this.#now()) return null;
    if (grant.role !== role || grant.presentingDeviceId !== presentingDeviceId) return null;

    grant.consumed = true; // single-use — the token is dead the instant it redeems
    return {
      sessionId: grant.sessionId,
      role: grant.role,
      peerDeviceId: grant.peerDeviceId,
      target: grant.target,
      identity: grant.identity,
    };
  }

  /** Drop expired/consumed grants (maintenance; redemption already ignores them). */
  sweep(): void {
    const now = this.#now();
    for (const [key, grant] of this.#grants) {
      if (grant.consumed || grant.expiresAtMs <= now) this.#grants.delete(key);
    }
  }
}

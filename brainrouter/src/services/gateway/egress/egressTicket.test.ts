import { describe, expect, it } from 'vitest';
import {
  EgressTicketRegistry,
  isReservedOriginDeviceId,
  ORIGIN_DEVICE_PREFIX,
  type EgressSessionIdentity,
} from './egressTicket.js';

const identity = (over: Partial<EgressSessionIdentity> = {}): EgressSessionIdentity => ({
  orgId: 'org-1',
  userId: 'user-1',
  clientDeviceId: 'dev-desktop-1',
  upstreamKeyId: 'key-abc',
  ...over,
});

const target = { host: 'api.provider.test', port: 443 };

/** A deterministic byte source so distinct tokens are still distinct across calls. */
function seededRandom(): (size: number) => Buffer {
  let n = 0;
  return (size: number) => Buffer.alloc(size, (n++ % 251) + 1);
}

function registry(nowRef?: { ms: number }): EgressTicketRegistry {
  return new EgressTicketRegistry({
    random: seededRandom(),
    now: nowRef ? () => nowRef.ms : undefined,
  });
}

describe('EgressTicketRegistry — issuance', () => {
  it('binds the server-validated target and mints a distinct token pair', () => {
    const pair = registry().issue(target, identity());
    expect(pair.target).toEqual(target);
    expect(pair.origin.token).not.toEqual(pair.client.token);
    expect(pair.origin.role).toBe('origin');
    expect(pair.client.role).toBe('client');
    // origin id is reserved and mutually references the client device
    expect(isReservedOriginDeviceId(pair.origin.presentingDeviceId)).toBe(true);
    expect(pair.origin.peerDeviceId).toBe('dev-desktop-1');
    expect(pair.client.peerDeviceId).toBe(pair.origin.presentingDeviceId);
  });

  it('refuses to mint for a client device in the reserved origin namespace', () => {
    expect(() => registry().issue(target, identity({ clientDeviceId: `${ORIGIN_DEVICE_PREFIX}forged` })))
      .toThrow(/reserved/i);
  });
});

describe('EgressTicketRegistry — redemption', () => {
  it('redeems each half in its own seat and yields the bound target', () => {
    const reg = registry();
    const pair = reg.issue(target, identity());

    const origin = reg.redeem(pair.origin.token, 'origin', pair.origin.presentingDeviceId);
    const client = reg.redeem(pair.client.token, 'client', pair.client.presentingDeviceId);
    expect(origin?.target).toEqual(target);
    expect(origin?.peerDeviceId).toBe('dev-desktop-1');
    expect(client?.peerDeviceId).toBe(pair.origin.presentingDeviceId);
    expect(client?.identity.upstreamKeyId).toBe('key-abc');
  });

  it('is single-use — a redeemed token is dead (reinforcement #3)', () => {
    const reg = registry();
    const pair = reg.issue(target, identity());
    expect(reg.redeem(pair.client.token, 'client', pair.client.presentingDeviceId)).not.toBeNull();
    expect(reg.redeem(pair.client.token, 'client', pair.client.presentingDeviceId)).toBeNull();
  });

  it('rejects a token replayed in the wrong role seat (no cross-redemption)', () => {
    const reg = registry();
    const pair = reg.issue(target, identity());
    // client token presented as the origin role, and vice-versa
    expect(reg.redeem(pair.client.token, 'origin', pair.origin.presentingDeviceId)).toBeNull();
    expect(reg.redeem(pair.origin.token, 'client', pair.client.presentingDeviceId)).toBeNull();
  });

  it('rejects a valid token presented from the wrong device id', () => {
    const reg = registry();
    const pair = reg.issue(target, identity());
    expect(reg.redeem(pair.client.token, 'client', 'some-other-device')).toBeNull();
  });

  it('never lets a client present a reserved origin id (reinforcement #1)', () => {
    const reg = registry();
    const pair = reg.issue(target, identity());
    // even with the *origin* token, a client-role redemption at an origin id is refused
    expect(reg.redeem(pair.origin.token, 'client', pair.origin.presentingDeviceId)).toBeNull();
  });

  it('rejects an expired ticket (reinforcement #2 — tight TTL)', () => {
    const clock = { ms: 1_000_000 };
    const reg = registry(clock);
    const pair = reg.issue(target, identity());
    clock.ms += 21_000; // past the 20s default TTL
    expect(reg.redeem(pair.client.token, 'client', pair.client.presentingDeviceId)).toBeNull();
  });

  it('rejects an unknown token', () => {
    const reg = registry();
    reg.issue(target, identity());
    expect(reg.redeem('egt_not-a-real-token', 'client', 'dev-desktop-1')).toBeNull();
  });
});

describe('EgressTicketRegistry — TTL bounds', () => {
  it('refuses a TTL outside the tight single-use window', () => {
    expect(() => new EgressTicketRegistry({ ttlSeconds: 300 })).toThrow(/between 5 and 60/);
    expect(() => new EgressTicketRegistry({ ttlSeconds: 1 })).toThrow(/between 5 and 60/);
  });
});

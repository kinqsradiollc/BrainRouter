/**
 * ADR-035 D10 admission-unit guards: pending and authenticated leases enforce
 * every configured scope, release idempotently, and share a bounded byte window.
 */
import { describe, expect, it } from "vitest";

import { GatewayAudioAdmission, type GatewayAudioAdmissionLimits } from "./audio-streaming-admission.js";

const GENEROUS_LIMITS: GatewayAudioAdmissionLimits = {
  maxPendingStreams: 100,
  maxPendingStreamsPerIp: 100,
  maxStreams: 100,
  maxStreamsPerIp: 100,
  maxStreamsPerPrincipal: 100,
  maxStreamsPerOrg: 100,
  maxAggregateBytesPerSecond: 1_000,
};

function admission(overrides: Partial<GatewayAudioAdmissionLimits>): GatewayAudioAdmission {
  return new GatewayAudioAdmission({ ...GENEROUS_LIMITS, ...overrides });
}

describe("gateway audio admission leases", () => {
  it("bounds pending handshakes globally and per IP and releases each lease once", () => {
    const perIp = admission({ maxPendingStreamsPerIp: 1 });
    const first = perIp.tryAcquirePending("192.0.2.1");
    expect(first).not.toBeNull();
    expect(perIp.tryAcquirePending("192.0.2.1")).toBeNull();
    expect(perIp.tryAcquirePending("192.0.2.2")).not.toBeNull();
    first!.release();
    first!.release();
    expect(perIp.tryAcquirePending("192.0.2.1")).not.toBeNull();

    const global = admission({ maxPendingStreams: 1 });
    const globalFirst = global.tryAcquirePending("192.0.2.10");
    expect(globalFirst).not.toBeNull();
    expect(global.tryAcquirePending("192.0.2.11")).toBeNull();
    globalFirst!.release();
    expect(global.tryAcquirePending("192.0.2.11")).not.toBeNull();
  });

  it("bounds authenticated streams globally and by IP, principal, and organization", () => {
    const cases: Array<{
      limits: Partial<GatewayAudioAdmissionLimits>;
      first: readonly [string, string, string];
      second: readonly [string, string, string];
    }> = [
      {
        limits: { maxStreams: 1 },
        first: ["192.0.2.1", "user:1", "org-1"],
        second: ["192.0.2.2", "user:2", "org-2"],
      },
      {
        limits: { maxStreamsPerIp: 1 },
        first: ["192.0.2.1", "user:1", "org-1"],
        second: ["192.0.2.1", "user:2", "org-2"],
      },
      {
        limits: { maxStreamsPerPrincipal: 1 },
        first: ["192.0.2.1", "user:1", "org-1"],
        second: ["192.0.2.2", "user:1", "org-2"],
      },
      {
        limits: { maxStreamsPerOrg: 1 },
        first: ["192.0.2.1", "user:1", "org-1"],
        second: ["192.0.2.2", "user:2", "org-1"],
      },
    ];

    for (const entry of cases) {
      const limiter = admission(entry.limits);
      const first = limiter.tryAcquirePending(entry.first[0])!;
      expect(first.promote(entry.first[1], entry.first[2])).toBe(true);
      const blocked = limiter.tryAcquirePending(entry.second[0])!;
      expect(blocked.promote(entry.second[1], entry.second[2])).toBe(false);
      blocked.release();
      first.release();
      const retried = limiter.tryAcquirePending(entry.second[0])!;
      expect(retried.promote(entry.second[1], entry.second[2])).toBe(true);
      retried.release();
    }
  });

  it("applies and recovers the aggregate byte window only for promoted leases", () => {
    const limiter = admission({ maxAggregateBytesPerSecond: 5 });
    const lease = limiter.tryAcquirePending("192.0.2.1")!;
    expect(lease.consumeBytes(1, 0)).toBe(false);
    expect(lease.promote("user:1", "org-1")).toBe(true);
    expect(lease.consumeBytes(3, 0)).toBe(true);
    expect(lease.consumeBytes(2, 999)).toBe(true);
    expect(lease.consumeBytes(1, 999)).toBe(false);
    expect(lease.consumeBytes(5, 1_000)).toBe(true);
    expect(lease.consumeBytes(1, 1_000)).toBe(false);
  });
});

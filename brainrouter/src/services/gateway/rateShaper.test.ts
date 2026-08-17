/**
 * ADR-043 S1 (D5) — the rate-shaper. Deterministic: an injected clock, no timers.
 */
import { describe, expect, it } from "vitest";
import { RateShaper } from "./rateShaper.js";

describe("RateShaper — concurrency cap", () => {
  it("admits up to the cap, refuses beyond it, and readmits on release", () => {
    const rs = new RateShaper({ maxConcurrentPerKey: 2, rpmPerKey: 100, maxQueuePerKey: 10, now: () => 0 });
    const a = rs.tryAcquire("k", 0);
    const b = rs.tryAcquire("k", 0);
    expect(a.ok && b.ok).toBe(true);
    const c = rs.tryAcquire("k", 0);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toBe("concurrency");
    // release one → a slot frees.
    if (a.ok) a.release();
    expect(rs.tryAcquire("k", 0).ok).toBe(true);
  });

  it("release is idempotent (double-release never over-frees)", () => {
    const rs = new RateShaper({ maxConcurrentPerKey: 1, rpmPerKey: 100, maxQueuePerKey: 10, now: () => 0 });
    const a = rs.tryAcquire("k", 0);
    if (a.ok) { a.release(); a.release(); }
    // only ONE slot should exist regardless of the double release.
    const x = rs.tryAcquire("k", 0);
    expect(x.ok).toBe(true);
    expect(rs.tryAcquire("k", 0).ok).toBe(false);
  });

  it("keys are shaped independently (per-org sharding)", () => {
    const rs = new RateShaper({ maxConcurrentPerKey: 1, rpmPerKey: 100, maxQueuePerKey: 10, now: () => 0 });
    expect(rs.tryAcquire("org-a", 0).ok).toBe(true);
    expect(rs.tryAcquire("org-a", 0).ok).toBe(false); // a is full
    expect(rs.tryAcquire("org-b", 0).ok).toBe(true);  // b is untouched
  });
});

describe("RateShaper — rpm sliding window", () => {
  it("admits rpm requests within 60s, refuses the next, then readmits as the window slides", () => {
    const rs = new RateShaper({ maxConcurrentPerKey: 100, rpmPerKey: 3, maxQueuePerKey: 10 });
    // three at t=0..2s, all released immediately so concurrency is not the limiter.
    for (const t of [0, 1000, 2000]) { const r = rs.tryAcquire("k", t); if (r.ok) r.release(); }
    const over = rs.tryAcquire("k", 3000);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.reason).toBe("rpm");
      // oldest (t=0) ages out at 60_000; retry hint points there.
      expect(over.retryAfterMs).toBe(60_000 - 3000);
    }
    // once the oldest ages out, a slot reopens.
    const later = rs.tryAcquire("k", 60_001);
    expect(later.ok).toBe(true);
  });
});

describe("RateShaper — Retry-After backoff", () => {
  it("parks a key for the upstream's Retry-After, then admits again", () => {
    const rs = new RateShaper({ maxConcurrentPerKey: 100, rpmPerKey: 100, maxQueuePerKey: 10 });
    rs.noteRetryAfter("k", 30, 1000); // 30s from t=1000 → until 31000
    const during = rs.tryAcquire("k", 5000);
    expect(during.ok).toBe(false);
    if (!during.ok) { expect(during.reason).toBe("retry-after"); expect(during.retryAfterMs).toBe(31000 - 5000); }
    expect(rs.tryAcquire("k", 31_001).ok).toBe(true);
  });
  it("takes the LATER of two overlapping Retry-Afters (never shortens a backoff)", () => {
    const rs = new RateShaper({ maxConcurrentPerKey: 100, rpmPerKey: 100, maxQueuePerKey: 10 });
    rs.noteRetryAfter("k", 60, 0);
    rs.noteRetryAfter("k", 10, 0); // shorter — must not win
    const r = rs.tryAcquire("k", 5000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterMs).toBe(60_000 - 5000);
  });
});

describe("RateShaper — bounded queue", () => {
  it("accepts waiters up to the bound, then refuses; leaveQueue frees a slot", () => {
    const rs = new RateShaper({ maxConcurrentPerKey: 1, rpmPerKey: 100, maxQueuePerKey: 2 });
    expect(rs.enterQueue("k")).toBe(true);
    expect(rs.enterQueue("k")).toBe(true);
    expect(rs.enterQueue("k")).toBe(false); // full
    expect(rs.queueDepth("k")).toBe(2);
    rs.leaveQueue("k");
    expect(rs.enterQueue("k")).toBe(true);
  });
});

describe("RateShaper — parkedFor (the wedge fast-fail)", () => {
  it("reports remaining park time after a Retry-After, then 0 once it elapses", () => {
    const rs = new RateShaper({ maxConcurrentPerKey: 100, rpmPerKey: 100, maxQueuePerKey: 10 });
    expect(rs.parkedFor("k", 0)).toBe(0);
    rs.noteRetryAfter("k", 20, 1000); // parked until 21000
    expect(rs.parkedFor("k", 5000)).toBe(16000);
    expect(rs.parkedFor("k", 21_000)).toBe(0);
    expect(rs.parkedFor("other", 5000)).toBe(0);
  });
});

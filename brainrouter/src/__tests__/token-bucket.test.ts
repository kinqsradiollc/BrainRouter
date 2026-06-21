import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucket } from "../memory/llm/token-bucket.js";

// Freeze time so refill is exactly controlled; advance explicitly where needed.
describe("TokenBucket", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("consumes within the request budget, then sheds", () => {
    const b = new TokenBucket({ ratePerMin: 3 });
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false); // budget exhausted
  });

  it("is unlimited when no budgets are set", () => {
    const b = new TokenBucket({});
    for (let i = 0; i < 1000; i++) expect(b.tryConsume(9_999)).toBe(true);
  });

  it("enforces the token budget independently of the request budget", () => {
    const b = new TokenBucket({ tokensPerMin: 100 }); // requests unlimited
    expect(b.tryConsume(60)).toBe(true);   // 40 tokens left
    expect(b.tryConsume(60)).toBe(false);  // 60 > 40 → shed, nothing consumed
    expect(b.tryConsume(40)).toBe(true);   // exactly 40 left → ok
    expect(b.tryConsume(1)).toBe(false);   // 0 left
  });

  it("enforces the request budget independently of the token budget", () => {
    const b = new TokenBucket({ ratePerMin: 2 }); // tokens unlimited
    expect(b.tryConsume(1_000_000)).toBe(true);
    expect(b.tryConsume(1_000_000)).toBe(true);
    expect(b.tryConsume(1)).toBe(false); // out of request budget regardless of tokens
  });

  it("the stricter of the two budgets wins", () => {
    const b = new TokenBucket({ ratePerMin: 10, tokensPerMin: 5 });
    expect(b.tryConsume(5)).toBe(true);  // tokens → 0, requests → 9
    expect(b.tryConsume(1)).toBe(false); // tokens exhausted though 9 requests remain
  });

  it("sheds an over-budget single request without consuming anything", () => {
    const b = new TokenBucket({ tokensPerMin: 10 });
    expect(b.tryConsume(20)).toBe(false); // never satisfiable; consumes nothing
    expect(b.tryConsume(10)).toBe(true);  // full budget still intact
  });

  it("refills continuously over time and caps at the max (no overflow)", () => {
    const b = new TokenBucket({ ratePerMin: 60 }); // 1 request/second refill
    for (let i = 0; i < 60; i++) expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);          // exhausted

    vi.advanceTimersByTime(30_000);              // +30s → +30 requests
    expect(b.snapshot().requests).toBeCloseTo(30, 5);
    for (let i = 0; i < 30; i++) expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);

    vi.advanceTimersByTime(120_000);             // long gap → capped at 60, not 120
    expect(b.snapshot().requests).toBe(60);
  });
});

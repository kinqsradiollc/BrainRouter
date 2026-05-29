import { describe, expect, it } from "vitest";
import { backoffDelayMs, BASE_DELAY_MS, MAX_DELAY_MS } from "../memory/scheduler/backoff.js";

describe("backoffDelayMs", () => {
  it("grows exponentially from the base delay (no jitter)", () => {
    const noJitter = () => 0.5; // random*2-1 = 0 ⇒ jitter term zero
    expect(backoffDelayMs(1, noJitter)).toBe(BASE_DELAY_MS); // 30s
    expect(backoffDelayMs(2, noJitter)).toBe(BASE_DELAY_MS * 2); // 60s
    expect(backoffDelayMs(3, noJitter)).toBe(BASE_DELAY_MS * 4); // 120s
  });

  it("caps at MAX_DELAY_MS", () => {
    const noJitter = () => 0.5;
    expect(backoffDelayMs(50, noJitter)).toBe(MAX_DELAY_MS);
  });

  it("stays within [0, MAX_DELAY_MS] across the jitter range and all attempts", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      for (let attempts = 1; attempts <= 20; attempts++) {
        const d = backoffDelayMs(attempts, () => r);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(MAX_DELAY_MS);
      }
    }
  });

  it("treats attempts < 1 as 1", () => {
    const noJitter = () => 0.5;
    expect(backoffDelayMs(0, noJitter)).toBe(BASE_DELAY_MS);
    expect(backoffDelayMs(-5, noJitter)).toBe(BASE_DELAY_MS);
  });

  it("applies symmetric jitter (low random pulls below the base, high pushes above)", () => {
    const low = backoffDelayMs(2, () => 0); // -20%
    const mid = backoffDelayMs(2, () => 0.5); // 0%
    const high = backoffDelayMs(2, () => 1); // +20%
    expect(low).toBeLessThan(mid);
    expect(high).toBeGreaterThan(mid);
  });
});

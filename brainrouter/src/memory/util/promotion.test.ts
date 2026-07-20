import { describe, expect, it } from "vitest";
import {
  shouldPromoteToDurable,
  promotionThresholds,
  DEFAULT_PROMOTION_CONFIDENCE,
  DEFAULT_PROMOTION_MIN_CORROBORATIONS,
} from "./promotion.js";

describe("ADR-020 D4 — confidence promotion", () => {
  it("promotes a high-confidence, corroborated record", () => {
    expect(shouldPromoteToDurable({ confidence: 0.96, citationCount: 3 })).toBe(true);
    expect(shouldPromoteToDurable({ confidence: DEFAULT_PROMOTION_CONFIDENCE, citationCount: DEFAULT_PROMOTION_MIN_CORROBORATIONS })).toBe(true);
  });

  it("does not promote without both signals", () => {
    expect(shouldPromoteToDurable({ confidence: 0.99, citationCount: 1 })).toBe(false); // under-corroborated
    expect(shouldPromoteToDurable({ confidence: 0.8, citationCount: 10 })).toBe(false); // under-confident
  });

  it("never re-promotes a durable record or promotes an archived one", () => {
    expect(shouldPromoteToDurable({ confidence: 1, citationCount: 9, durable: true })).toBe(false);
    expect(shouldPromoteToDurable({ confidence: 1, citationCount: 9, archived: true })).toBe(false);
  });

  it("clamps override thresholds sanely", () => {
    const t = promotionThresholds({ confidence: 2, minCorroborations: 0 });
    expect(t.confidence).toBe(1);
    expect(t.minCorroborations).toBe(1);
    // a looser threshold promotes more
    expect(shouldPromoteToDurable({ confidence: 0.7, citationCount: 1 }, promotionThresholds({ confidence: 0.6, minCorroborations: 1 }))).toBe(true);
  });
});

/**
 * ADR-052 P2b — the org contracted-pricing normalizer + effective-rate resolver.
 */
import { describe, it, expect } from "vitest";
import { normalizeOrgPricingSettings, effectiveModelRate, PRICING_SETTING_FIELDS } from "./orgPricingSettings.js";

describe("normalizeOrgPricingSettings", () => {
  it("clamps the discount multiplier to its range and drops junk", () => {
    expect(normalizeOrgPricingSettings({ discountMultiplier: 0.8 })).toEqual({ discountMultiplier: 0.8 });
    expect(normalizeOrgPricingSettings({ discountMultiplier: 5 }).discountMultiplier).toBe(2); // clamped max
    expect(normalizeOrgPricingSettings({ discountMultiplier: 0 }).discountMultiplier).toBe(0.01); // clamped min
    expect(normalizeOrgPricingSettings({ discountMultiplier: "nope" })).toEqual({}); // unparseable dropped
  });

  it("keeps only per-model rates with a non-negative finite side", () => {
    const out = normalizeOrgPricingSettings({
      rates: {
        "opus-5": { inputPerMTok: 12, outputPerMTok: 60 },
        "sonnet-5": { inputPerMTok: 2 }, // one side is fine
        "bad": { inputPerMTok: -1, outputPerMTok: "x" }, // both invalid → dropped
        "": { inputPerMTok: 1 }, // empty id → dropped
      },
    });
    expect(out.rates).toEqual({ "opus-5": { inputPerMTok: 12, outputPerMTok: 60 }, "sonnet-5": { inputPerMTok: 2 } });
  });

  it("ignores non-object input", () => {
    expect(normalizeOrgPricingSettings(null)).toEqual({});
    expect(normalizeOrgPricingSettings("x")).toEqual({});
    expect(normalizeOrgPricingSettings([1, 2])).toEqual({});
  });

  it("exposes the discount field for the admin UI", () => {
    expect(PRICING_SETTING_FIELDS.map((f) => f.key)).toContain("discountMultiplier");
  });
});

describe("effectiveModelRate", () => {
  it("an explicit contracted rate wins over the discounted list price", () => {
    const s = normalizeOrgPricingSettings({ discountMultiplier: 0.5, rates: { "opus-5": { inputPerMTok: 9, outputPerMTok: 45 } } });
    expect(effectiveModelRate(s, "opus-5", 15, 75)).toEqual({ inputPerMTok: 9, outputPerMTok: 45 });
  });
  it("without an explicit rate, the list price is scaled by the discount multiplier", () => {
    const s = normalizeOrgPricingSettings({ discountMultiplier: 0.8 });
    const r = effectiveModelRate(s, "sonnet-5", 3, 15);
    expect(r.inputPerMTok).toBeCloseTo(2.4, 10);
    expect(r.outputPerMTok).toBeCloseTo(12, 10);
  });
  it("no settings ⇒ list price unchanged", () => {
    expect(effectiveModelRate({}, "haiku", 1, 5)).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
  });
});

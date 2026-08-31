/**
 * ADR-054 P1 — the per-org usage aggregate: bounded merge + priced view.
 */
import { describe, it, expect } from "vitest";
import { mergeOrgUsage, priceOrgUsage, MAX_AUTOMATIONS, type OrgUsageAggregate } from "./orgUsageAggregate.js";
import { normalizeOrgPricingSettings } from "../pricing/orgPricingSettings.js";

const list = () => ({ inputPerMTok: 15, outputPerMTok: 75 });

describe("mergeOrgUsage", () => {
  it("folds a delta into a named automation and accumulates", () => {
    let agg: OrgUsageAggregate = {};
    agg = mergeOrgUsage(agg, { automation: "loop:build", promptTokens: 100, completionTokens: 20, calls: 1, turns: 1, model: "opus-5" });
    agg = mergeOrgUsage(agg, { automation: "loop:build", promptTokens: 50, completionTokens: 10, calls: 1 });
    expect(agg["loop:build"]).toEqual({ promptTokens: 150, completionTokens: 30, calls: 2, turns: 1, model: "opus-5" });
  });

  it("drops an unattributed delta (never a nameless bucket)", () => {
    expect(mergeOrgUsage({}, { automation: "  ", promptTokens: 999 })).toEqual({});
  });

  it("ignores negative / non-finite token counts", () => {
    const agg = mergeOrgUsage({}, { automation: "x", promptTokens: -5, completionTokens: NaN as unknown as number, calls: 2 });
    expect(agg["x"]).toEqual({ promptTokens: 0, completionTokens: 0, calls: 2, turns: 0 });
  });

  it("stays bounded to the top-N automations by tokens", () => {
    let agg: OrgUsageAggregate = {};
    for (let i = 0; i < MAX_AUTOMATIONS + 20; i++) agg = mergeOrgUsage(agg, { automation: `a${i}`, promptTokens: i + 1 });
    expect(Object.keys(agg).length).toBe(MAX_AUTOMATIONS);
    expect(agg["a0"]).toBeUndefined(); // the smallest were dropped
    expect(agg[`a${MAX_AUTOMATIONS + 19}`]).toBeDefined(); // the largest kept
  });
});

describe("priceOrgUsage", () => {
  it("prices per automation at the org's contracted rate, cost-desc", () => {
    const agg: OrgUsageAggregate = {
      "loop:big": { promptTokens: 1_000_000, completionTokens: 200_000, calls: 5, turns: 5, model: "opus-5" },
      "interactive": { promptTokens: 100_000, completionTokens: 10_000, calls: 2, turns: 2, model: "opus-5" },
    };
    const pricing = normalizeOrgPricingSettings({ discountMultiplier: 0.8 }); // 20% off list
    const rows = priceOrgUsage(agg, pricing, list);
    expect(rows[0].automation).toBe("loop:big"); // most expensive first
    // 1M prompt @ 15*0.8=12 + 0.2M completion @ 75*0.8=60 → 12 + 12 = 24
    expect(rows[0].estCostUsd).toBeCloseTo(24, 6);
  });

  it("an unknown model defaults to zero list rate (no phantom cost)", () => {
    const rows = priceOrgUsage({ x: { promptTokens: 1_000_000, completionTokens: 0, calls: 1, turns: 1 } }, {}, () => ({ inputPerMTok: 0, outputPerMTok: 0 }));
    expect(rows[0].estCostUsd).toBe(0);
  });

  it("an explicit per-model contracted rate overrides list price", () => {
    const agg: OrgUsageAggregate = { "loop": { promptTokens: 1_000_000, completionTokens: 0, calls: 1, turns: 1, model: "opus-5" } };
    const pricing = normalizeOrgPricingSettings({ rates: { "opus-5": { inputPerMTok: 9 } } });
    expect(priceOrgUsage(agg, pricing, list)[0].estCostUsd).toBeCloseTo(9, 6);
  });
});

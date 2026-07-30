import { describe, expect, it } from "vitest";
import { ORG_PLANS, isOrgPlan, normalizeOrgPlan } from "../tenancy/types.js";

describe("ORG-PLAN — plan tiers (single source of truth)", () => {
  it("exposes exactly the known plan tiers", () => {
    expect([...ORG_PLANS]).toEqual(["free", "pro", "team", "enterprise", "self_hosted_enterprise"]);
  });

  it("isOrgPlan accepts every known plan", () => {
    for (const plan of ORG_PLANS) expect(isOrgPlan(plan)).toBe(true);
  });

  it("isOrgPlan rejects unknown / malformed / legacy values", () => {
    for (const bad of ["", "single", "FREE", "Team", "basic", 1, null, undefined, {}]) {
      expect(isOrgPlan(bad)).toBe(false);
    }
  });

  it("normalizeOrgPlan maps the legacy 'single' tier to 'free'", () => {
    expect(normalizeOrgPlan("single")).toBe("free");
  });

  it("normalizeOrgPlan passes through valid tiers and defaults unknowns to 'free'", () => {
    expect(normalizeOrgPlan("enterprise")).toBe("enterprise");
    expect(normalizeOrgPlan("self_hosted_enterprise")).toBe("self_hosted_enterprise");
    expect(normalizeOrgPlan("bogus")).toBe("free");
    expect(normalizeOrgPlan(undefined)).toBe("free");
  });
});

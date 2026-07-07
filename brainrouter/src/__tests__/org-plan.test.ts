import { describe, expect, it } from "vitest";
import { ORG_PLANS, isOrgPlan } from "../tenancy/types.js";

describe("ORG-PLAN — plan tiers (single source of truth)", () => {
  it("exposes exactly the known plan tiers", () => {
    expect([...ORG_PLANS]).toEqual(["single", "team", "enterprise"]);
  });

  it("isOrgPlan accepts every known plan", () => {
    for (const plan of ORG_PLANS) expect(isOrgPlan(plan)).toBe(true);
  });

  it("isOrgPlan rejects unknown / malformed values", () => {
    for (const bad of ["", "free", "pro", "TEAM", "Enterprise", 1, null, undefined, {}]) {
      expect(isOrgPlan(bad)).toBe(false);
    }
  });
});

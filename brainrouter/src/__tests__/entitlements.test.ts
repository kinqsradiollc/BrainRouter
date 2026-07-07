import { describe, expect, it } from "vitest";
import {
  PLAN_ENTITLEMENTS,
  entitlementsFor,
  planHasFeature,
  withinLimit,
  featuresFor,
} from "../tenancy/entitlements.js";

describe("PLAN-ENTITLEMENTS (single source of truth)", () => {
  it("defines exactly the three plans", () => {
    expect(Object.keys(PLAN_ENTITLEMENTS).sort()).toEqual(["enterprise", "single", "team"]);
  });

  it("single is the most restrictive: 1 seat, no team features", () => {
    expect(entitlementsFor("single").limits.seats).toBe(1);
    expect(featuresFor("single")).toEqual([]);
    expect(planHasFeature("single", "sharedMemory")).toBe(false);
    expect(planHasFeature("single", "invites")).toBe(false);
  });

  it("team unlocks shared memory + persona + invites, capped seats/projects", () => {
    expect(planHasFeature("team", "sharedMemory")).toBe(true);
    expect(planHasFeature("team", "orgPersona")).toBe(true);
    expect(planHasFeature("team", "invites")).toBe(true);
    expect(planHasFeature("team", "domainAllowlist")).toBe(false); // enterprise-only
    expect(entitlementsFor("team").limits.seats).toBe(10);
  });

  it("enterprise unlocks everything with unlimited seats/projects", () => {
    expect(entitlementsFor("enterprise").limits.seats).toBeNull();
    expect(entitlementsFor("enterprise").limits.projects).toBeNull();
    for (const f of ["domainAllowlist", "sso", "restrictedProjects"] as const) {
      expect(planHasFeature("enterprise", f)).toBe(true);
    }
  });

  it("withinLimit enforces caps and treats null as unlimited", () => {
    // single: 1 seat — adding the 2nd member is blocked
    expect(withinLimit("single", "seats", 1)).toBe(false);
    expect(withinLimit("single", "seats", 0)).toBe(true);
    // team: 10 seats
    expect(withinLimit("team", "seats", 9)).toBe(true);
    expect(withinLimit("team", "seats", 10)).toBe(false);
    // enterprise: unlimited
    expect(withinLimit("enterprise", "seats", 9999)).toBe(true);
  });

  it("unknown plans fall back to the most restrictive tier (fail-closed)", () => {
    expect(entitlementsFor("bogus").limits.seats).toBe(1);
    expect(planHasFeature(undefined, "sharedMemory")).toBe(false);
    expect(planHasFeature(null, "invites")).toBe(false);
  });
});

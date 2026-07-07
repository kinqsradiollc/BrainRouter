import { describe, expect, it } from "vitest";
import {
  PLAN_ENTITLEMENTS,
  entitlementsFor,
  planHasFeature,
  withinLimit,
  featuresFor,
} from "../tenancy/entitlements.js";

describe("PLAN-ENTITLEMENTS (single source of truth)", () => {
  it("defines exactly the five plans", () => {
    expect(Object.keys(PLAN_ENTITLEMENTS).sort()).toEqual([
      "enterprise",
      "free",
      "pro",
      "self_hosted_enterprise",
      "team",
    ]);
  });

  it("free is the most restrictive: 1 seat, no team features", () => {
    expect(entitlementsFor("free").limits.seats).toBe(1);
    expect(featuresFor("free")).toEqual([]);
    expect(planHasFeature("free", "sharedMemory")).toBe(false);
    expect(planHasFeature("free", "invites")).toBe(false);
  });

  it("pro is still solo (1 seat) but unlocks hosted MCP + advanced connectors", () => {
    expect(entitlementsFor("pro").limits.seats).toBe(1);
    expect(planHasFeature("pro", "hostedMcp")).toBe(true);
    expect(planHasFeature("pro", "advancedConnectors")).toBe(true);
    expect(planHasFeature("pro", "sharedMemory")).toBe(false); // solo → no team sharing
  });

  it("team unlocks shared memory + persona + invites, capped seats/projects", () => {
    expect(planHasFeature("team", "sharedMemory")).toBe(true);
    expect(planHasFeature("team", "orgPersona")).toBe(true);
    expect(planHasFeature("team", "invites")).toBe(true);
    expect(planHasFeature("team", "domainAllowlist")).toBe(false); // enterprise-only
    expect(entitlementsFor("team").limits.seats).toBe(10);
  });

  it("enterprise (and self-hosted) unlock everything, unlimited seats/projects", () => {
    for (const plan of ["enterprise", "self_hosted_enterprise"] as const) {
      expect(entitlementsFor(plan).limits.seats).toBeNull();
      expect(entitlementsFor(plan).limits.projects).toBeNull();
      for (const f of ["domainAllowlist", "sso", "restrictedProjects", "auditLogs"] as const) {
        expect(planHasFeature(plan, f)).toBe(true);
      }
    }
  });

  it("withinLimit enforces caps and treats null as unlimited", () => {
    expect(withinLimit("free", "seats", 1)).toBe(false); // 1-seat plan, adding 2nd blocked
    expect(withinLimit("free", "seats", 0)).toBe(true);
    expect(withinLimit("team", "seats", 9)).toBe(true);
    expect(withinLimit("team", "seats", 10)).toBe(false);
    expect(withinLimit("enterprise", "seats", 9999)).toBe(true);
  });

  it("unknown plans fall back to the most restrictive tier (fail-closed)", () => {
    expect(entitlementsFor("bogus").limits.seats).toBe(1);
    expect(planHasFeature(undefined, "sharedMemory")).toBe(false);
    expect(planHasFeature(null, "invites")).toBe(false);
  });
});

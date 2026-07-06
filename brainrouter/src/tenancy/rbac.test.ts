import { describe, expect, it } from "vitest";
import {
  can,
  roleAtLeast,
  isRole,
  capabilitiesFor,
  ROLES,
  CAPABILITIES,
  ROLE_CAPABILITIES,
  type Role,
} from "./rbac.js";

describe("RBAC roles + capabilities (ADR-010)", () => {
  it("owner holds every capability", () => {
    for (const cap of CAPABILITIES) expect(can("owner", cap)).toBe(true);
    expect(capabilitiesFor("owner").length).toBe(CAPABILITIES.length);
  });

  it("admin can configure providers/triggers/members but NOT org:manage", () => {
    expect(can("admin", "providers:manage")).toBe(true);
    expect(can("admin", "triggers:manage")).toBe(true);
    expect(can("admin", "members:manage")).toBe(true);
    expect(can("admin", "org:manage")).toBe(false);
  });

  it("member can read/write/share memory but cannot configure providers or triggers", () => {
    expect(can("member", "memory:write")).toBe(true);
    expect(can("member", "memory:read")).toBe(true);
    expect(can("member", "memory:share")).toBe(true);
    expect(can("member", "providers:manage")).toBe(false);
    expect(can("member", "triggers:manage")).toBe(false);
    expect(can("member", "members:manage")).toBe(false);
  });

  it("viewer is read-only", () => {
    expect(can("viewer", "memory:read")).toBe(true);
    expect(can("viewer", "memory:write")).toBe(false);
    expect(can("viewer", "memory:share")).toBe(false);
    expect(can("viewer", "providers:manage")).toBe(false);
    expect(capabilitiesFor("viewer")).toEqual(["memory:read"]);
  });

  it("providers:manage + triggers:manage are admin-or-above only (the goal's 'only admin can do it')", () => {
    const canConfigProviders = ROLES.filter((r) => can(r, "providers:manage"));
    const canConfigTriggers = ROLES.filter((r) => can(r, "triggers:manage"));
    expect(canConfigProviders.sort()).toEqual(["admin", "owner"]);
    expect(canConfigTriggers.sort()).toEqual(["admin", "owner"]);
  });

  it("roleAtLeast respects the owner > admin > member > viewer order", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(roleAtLeast("viewer", "member")).toBe(false);
    expect(roleAtLeast("admin", "viewer")).toBe(true);
  });

  it("unknown / invalid roles grant nothing (fail closed)", () => {
    for (const cap of CAPABILITIES) {
      expect(can("root", cap)).toBe(false);
      expect(can(undefined, cap)).toBe(false);
      expect(can(null, cap)).toBe(false);
      expect(can("", cap)).toBe(false);
    }
    expect(roleAtLeast("root", "viewer")).toBe(false);
    expect(capabilitiesFor("nope")).toEqual([]);
  });

  it("isRole narrows the known set", () => {
    for (const r of ROLES) expect(isRole(r)).toBe(true);
    expect(isRole("editor")).toBe(false);
    expect(isRole(42)).toBe(false);
  });

  it("every role's capability set is a subset of the more-privileged role (monotonic)", () => {
    const order: Role[] = ["viewer", "member", "admin", "owner"];
    for (let i = 0; i < order.length - 1; i++) {
      const lower = ROLE_CAPABILITIES[order[i]];
      const higher = ROLE_CAPABILITIES[order[i + 1]];
      for (const cap of lower) {
        expect(higher.has(cap)).toBe(true);
      }
    }
  });
});

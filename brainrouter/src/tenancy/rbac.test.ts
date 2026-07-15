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
    expect(can("admin", "models:read")).toBe(true);
    expect(can("admin", "models:manage")).toBe(true);
    expect(can("admin", "triggers:manage")).toBe(true);
    expect(can("admin", "members:manage")).toBe(true);
    expect(can("admin", "org:manage")).toBe(false);
  });

  it("developer can read/write/share memory but cannot configure providers or triggers", () => {
    expect(can("developer", "memory:write")).toBe(true);
    expect(can("developer", "memory:read")).toBe(true);
    expect(can("developer", "memory:share")).toBe(true);
    expect(can("developer", "providers:manage")).toBe(false);
    expect(can("developer", "models:read")).toBe(true);
    expect(can("developer", "models:manage")).toBe(false);
    expect(can("developer", "triggers:manage")).toBe(false);
    expect(can("developer", "members:manage")).toBe(false);
    expect(can("developer", "reviews:read")).toBe(true);
    expect(can("developer", "reviews:run")).toBe(false);
  });

  it("legacy role names map to canonical ones (member→developer, manager→admin)", () => {
    expect(can("member", "memory:write")).toBe(true);
    expect(can("member", "providers:manage")).toBe(false);
    expect(can("manager", "triggers:manage")).toBe(true);
    expect(can("manager", "org:manage")).toBe(false);
    expect(capabilitiesFor("member")).toEqual(capabilitiesFor("developer"));
  });

  it("viewer is read-only", () => {
    expect(can("viewer", "memory:read")).toBe(true);
    expect(can("viewer", "memory:write")).toBe(false);
    expect(can("viewer", "memory:share")).toBe(false);
    expect(can("viewer", "providers:manage")).toBe(false);
    expect(can("viewer", "models:read")).toBe(true);
    expect(can("viewer", "models:manage")).toBe(false);
    expect(can("viewer", "reviews:read")).toBe(false);
    expect(can("viewer", "reviews:run")).toBe(false);
    expect(capabilitiesFor("viewer")).toEqual(["models:read", "remote:read", "memory:read", "vulnerabilities:read"]);
  });

  it("every member can read the safe model catalog while only admins manage it", () => {
    expect(ROLES.filter((role) => can(role, "models:read")).sort()).toEqual([
      "admin",
      "developer",
      "owner",
      "viewer",
    ]);
    expect(ROLES.filter((role) => can(role, "models:manage")).sort()).toEqual([
      "admin",
      "owner",
    ]);
  });

  it("separates vulnerability browsing, scanning, and source management (spec §10.3)", () => {
    expect(ROLES.filter((role) => can(role, "vulnerabilities:read")).sort()).toEqual([
      "admin",
      "developer",
      "owner",
      "viewer",
    ]);
    expect(ROLES.filter((role) => can(role, "vulnerabilities:scan")).sort()).toEqual([
      "admin",
      "developer",
      "owner",
    ]);
    expect(ROLES.filter((role) => can(role, "vulnerabilities:manage")).sort()).toEqual([
      "admin",
      "owner",
    ]);
  });

  it("review capabilities intentionally separate read access from manual runs", () => {
    expect(can("owner", "reviews:read")).toBe(true);
    expect(can("owner", "reviews:run")).toBe(true);
    expect(can("admin", "reviews:read")).toBe(true);
    expect(can("admin", "reviews:run")).toBe(true);
    expect(can("developer", "reviews:read")).toBe(true);
    expect(can("developer", "reviews:run")).toBe(false);
  });

  it("separates remote visibility, connection, and management authority", () => {
    expect(ROLES.filter((role) => can(role, "remote:read")).sort()).toEqual([
      "admin",
      "developer",
      "owner",
      "viewer",
    ]);
    expect(ROLES.filter((role) => can(role, "remote:connect")).sort()).toEqual([
      "admin",
      "developer",
      "owner",
    ]);
    expect(ROLES.filter((role) => can(role, "remote:manage")).sort()).toEqual([
      "admin",
      "developer",
      "owner",
    ]);
  });

  it("providers:manage + triggers:manage are admin-or-above only (the goal's 'only admin can do it')", () => {
    const canConfigProviders = ROLES.filter((r) => can(r, "providers:manage"));
    const canConfigTriggers = ROLES.filter((r) => can(r, "triggers:manage"));
    expect(canConfigProviders.sort()).toEqual(["admin", "owner"]);
    expect(canConfigTriggers.sort()).toEqual(["admin", "owner"]);
  });

  it("roleAtLeast respects the owner > admin > developer > viewer order", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "admin")).toBe(true);
    expect(roleAtLeast("developer", "admin")).toBe(false);
    expect(roleAtLeast("viewer", "developer")).toBe(false);
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
    const order: Role[] = ["viewer", "developer", "admin", "owner"];
    for (let i = 0; i < order.length - 1; i++) {
      const lower = ROLE_CAPABILITIES[order[i]];
      const higher = ROLE_CAPABILITIES[order[i + 1]];
      for (const cap of lower) {
        expect(higher.has(cap)).toBe(true);
      }
    }
  });
});

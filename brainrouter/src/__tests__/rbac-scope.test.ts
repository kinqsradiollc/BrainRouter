import { describe, expect, it } from "vitest";
import { scopedUserId, errorStatus, ScopeError, type ScopeRequest } from "../api/middleware/scope.js";

const reqAs = (userId: string, isAdmin = false): ScopeRequest => ({ userId, isAdmin });

describe("RBAC-ENFORCE scopedUserId (single source of truth)", () => {
  it("returns the caller's own id when no userId is requested", () => {
    expect(scopedUserId(reqAs("u1"), undefined)).toBe("u1");
    expect(scopedUserId(reqAs("u1"), "")).toBe("u1");
    expect(scopedUserId(reqAs("u1"), "   ")).toBe("u1");
  });

  it("returns own id when the requested id matches self (trimmed)", () => {
    expect(scopedUserId(reqAs("u1"), "u1")).toBe("u1");
    expect(scopedUserId(reqAs("u1"), "  u1  ")).toBe("u1");
  });

  it("lets an admin target another user", () => {
    expect(scopedUserId(reqAs("admin", true), "u2")).toBe("u2");
  });

  it("throws ScopeError(403) when a non-admin requests another user's data", () => {
    expect(() => scopedUserId(reqAs("u1"), "u2", "evidence")).toThrow(ScopeError);
    try {
      scopedUserId(reqAs("u1"), "u2", "working memory");
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeError);
      expect((e as ScopeError).status).toBe(403);
      expect((e as Error).message).toMatch(/another user's working memory/);
    }
  });

  it("default resource label is 'data'", () => {
    try {
      scopedUserId(reqAs("u1"), "u2");
    } catch (e) {
      expect((e as Error).message).toBe("Cannot access another user's data");
    }
  });
});

describe("RBAC-ENFORCE errorStatus", () => {
  it("maps a ScopeError to 403, falls back otherwise", () => {
    expect(errorStatus(new ScopeError("x"), 400)).toBe(403);
    expect(errorStatus(new ScopeError("x"), 500)).toBe(403);
    expect(errorStatus(new Error("plain"), 400)).toBe(400);
    expect(errorStatus(new Error("plain"), 500)).toBe(500);
    expect(errorStatus({ status: 404 }, 400)).toBe(404);
    expect(errorStatus(null, 400)).toBe(400);
    expect(errorStatus(undefined, 422)).toBe(422);
  });
});

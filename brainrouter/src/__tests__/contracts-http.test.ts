import { describe, expect, it } from "vitest";
import type { Response } from "express";
import { z } from "zod";
import { sendError, codeForStatus, statusForError, ERROR_CODES } from "../contracts/http.js";

function mkRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

describe("CONTRACTS-HTTP — codeForStatus", () => {
  it("maps every known status to its stable code", () => {
    for (const [status, code] of Object.entries(ERROR_CODES)) {
      expect(codeForStatus(Number(status))).toBe(code);
    }
  });

  it("falls back to internal_error for 5xx and error otherwise", () => {
    expect(codeForStatus(500)).toBe("internal_error");
    expect(codeForStatus(503)).toBe("internal_error");
    expect(codeForStatus(418)).toBe("error");
  });
});

describe("CONTRACTS-HTTP — statusForError", () => {
  it("resolves known error shapes", () => {
    const zerr = z.object({ a: z.string() }).safeParse({ a: 1 });
    expect(statusForError(zerr.success ? null : zerr.error)).toBe(400);
    expect(statusForError({ name: "ScopeError" })).toBe(403);
    expect(statusForError({ status: 404 })).toBe(404);
    expect(statusForError({ statusCode: 409 })).toBe(409);
    expect(statusForError(new Error("boom"))).toBe(500);
    expect(statusForError({ status: 1234 })).toBe(500);
  });
});

describe("CONTRACTS-HTTP — sendError", () => {
  it("emits the { error, code } envelope an inline route guard returns", () => {
    const res = mkRes();
    sendError(res as unknown as Response, 404, "Memory not found");
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Memory not found", code: "not_found" });
  });

  it("includes details only when provided", () => {
    const res = mkRes();
    sendError(res as unknown as Response, 400, "bad", [{ path: "x", message: "nope" }]);
    expect(res.body).toEqual({ error: "bad", code: "bad_request", details: [{ path: "x", message: "nope" }] });
  });

  it("returns the Response so callers can `return sendError(...)`", () => {
    const res = mkRes();
    const out = sendError(res as unknown as Response, 401, "API key required");
    expect(out).toBe(res);
    expect(res.body).toEqual({ error: "API key required", code: "unauthorized" });
  });
});

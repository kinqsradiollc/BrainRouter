import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { z } from "zod";
import { errorHandler, statusForError, codeForStatus } from "../api/middleware/errorHandler.js";

function mkReq(): Request {
  return { method: "POST", originalUrl: "/api/thing" } as unknown as Request;
}

function mkRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    sent: false,
    headersSent: false,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      this.sent = true;
      return this;
    },
  };
  return res;
}

const silentLog = () => {};

function zodError() {
  const parsed = z.object({ status: z.enum(["a", "b"]) }).safeParse({ status: "x" });
  return parsed.success ? new Error("unexpected") : parsed.error;
}

describe("API-ERRORS — statusForError / codeForStatus", () => {
  it("maps known error shapes to statuses", () => {
    expect(statusForError(zodError())).toBe(400);
    expect(statusForError({ name: "ScopeError" })).toBe(403);
    expect(statusForError({ status: 404 })).toBe(404);
    expect(statusForError({ statusCode: 409 })).toBe(409);
    expect(statusForError(new Error("boom"))).toBe(500);
    expect(statusForError({ status: 1234 })).toBe(500); // out of range → 500
  });

  it("maps statuses to stable codes", () => {
    expect(codeForStatus(400)).toBe("bad_request");
    expect(codeForStatus(403)).toBe("forbidden");
    expect(codeForStatus(429)).toBe("rate_limited");
    expect(codeForStatus(500)).toBe("internal_error");
    expect(codeForStatus(418)).toBe("error");
  });
});

describe("API-ERRORS — errorHandler middleware", () => {
  it("emits a forbidden envelope for a ScopeError", () => {
    const res = mkRes();
    const err = Object.assign(new Error("Out of scope"), { name: "ScopeError" });
    errorHandler({ logger: silentLog })(err, mkReq(), res as unknown as Response, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Out of scope", code: "forbidden" });
  });

  it("never leaks an internal 5xx message/stack in production", () => {
    const res = mkRes();
    errorHandler({ production: true, logger: silentLog })(new Error("db password = hunter2"), mkReq(), res as unknown as Response, () => {});
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error", code: "internal_error" });
  });

  it("surfaces the 5xx message + stack in dev for debugging", () => {
    const res = mkRes();
    errorHandler({ production: false, logger: silentLog })(new Error("kaboom"), mkReq(), res as unknown as Response, () => {});
    expect(res.statusCode).toBe(500);
    const body = res.body as { error: string; details?: unknown };
    expect(body.error).toBe("kaboom");
    expect(typeof body.details).toBe("string"); // stack
  });

  it("includes zod field details on a 400", () => {
    const res = mkRes();
    errorHandler({ logger: silentLog })(zodError(), mkReq(), res as unknown as Response, () => {});
    expect(res.statusCode).toBe(400);
    const body = res.body as { code: string; details?: Array<{ path: string }> };
    expect(body.code).toBe("bad_request");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details![0].path).toContain("status");
  });

  it("respects an explicit string error code", () => {
    const res = mkRes();
    errorHandler({ logger: silentLog })({ status: 409, code: "already_exists", message: "dupe" }, mkReq(), res as unknown as Response, () => {});
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "dupe", code: "already_exists" });
  });

  it("delegates to next when headers already sent", () => {
    const res = mkRes();
    res.headersSent = true;
    let delegated: unknown = null;
    errorHandler({ logger: silentLog })(new Error("late"), mkReq(), res as unknown as Response, (e?: unknown) => { delegated = e; });
    expect(res.sent).toBe(false);
    expect(delegated).toBeInstanceOf(Error);
  });

  it("logs 5xx but not 4xx", () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    errorHandler({ logger: log })(new Error("server"), mkReq(), mkRes() as unknown as Response, () => {});
    errorHandler({ logger: log })({ name: "ScopeError", message: "client" }, mkReq(), mkRes() as unknown as Response, () => {});
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("500");
  });
});

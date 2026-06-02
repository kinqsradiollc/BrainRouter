import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { createRateLimiter } from "../api/middleware/rateLimit.js";

function mkReq(ip = "1.2.3.4"): Request {
  return { ip } as unknown as Request;
}

function mkRes() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    sent: false,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v;
    },
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

describe("API-RATELIMIT — createRateLimiter", () => {
  it("allows up to max then 429s with Retry-After + code", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, now: () => 1000 });
    let nexts = 0;
    const next = () => { nexts += 1; };

    const r1 = mkRes(); limiter(mkReq(), r1 as unknown as Response, next);
    const r2 = mkRes(); limiter(mkReq(), r2 as unknown as Response, next);
    const r3 = mkRes(); limiter(mkReq(), r3 as unknown as Response, next);

    expect(nexts).toBe(2);
    expect(r1.sent).toBe(false);
    expect(r2.sent).toBe(false);
    expect(r3.statusCode).toBe(429);
    expect((r3.body as { code: string }).code).toBe("rate_limited");
    expect(r3.headers["retry-after"]).toBeDefined();
    expect(Number(r3.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("keys buckets independently per IP", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now: () => 1000 });
    let nexts = 0;
    const next = () => { nexts += 1; };

    limiter(mkReq("a"), mkRes() as unknown as Response, next); // a #1 ok
    limiter(mkReq("b"), mkRes() as unknown as Response, next); // b #1 ok
    const aOver = mkRes();
    limiter(mkReq("a"), aOver as unknown as Response, next);   // a #2 blocked

    expect(nexts).toBe(2);
    expect(aOver.statusCode).toBe(429);
  });

  it("resets the window once the clock passes resetAt", () => {
    let t = 1000;
    const limiter = createRateLimiter({ windowMs: 5_000, max: 1, now: () => t });
    let nexts = 0;
    const next = () => { nexts += 1; };

    limiter(mkReq(), mkRes() as unknown as Response, next);      // #1 ok
    const blocked = mkRes();
    limiter(mkReq(), blocked as unknown as Response, next);      // #2 blocked
    expect(blocked.statusCode).toBe(429);

    t = 1000 + 5_001;                                            // window elapsed
    limiter(mkReq(), mkRes() as unknown as Response, next);      // ok again
    expect(nexts).toBe(2);
  });

  it("max<=0 disables the limiter (always passes through)", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 0 });
    let nexts = 0;
    const next = () => { nexts += 1; };
    for (let i = 0; i < 50; i++) {
      const res = mkRes();
      limiter(mkReq(), res as unknown as Response, next);
      expect(res.sent).toBe(false);
    }
    expect(nexts).toBe(50);
  });

  it("surfaces a custom message + code", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, message: "Too many auth attempts", code: "auth_rate_limited", now: () => 1000 });
    const next = () => {};
    limiter(mkReq(), mkRes() as unknown as Response, next);
    const blocked = mkRes();
    limiter(mkReq(), blocked as unknown as Response, next);
    expect(blocked.body).toEqual({ error: "Too many auth attempts", code: "auth_rate_limited" });
  });
});

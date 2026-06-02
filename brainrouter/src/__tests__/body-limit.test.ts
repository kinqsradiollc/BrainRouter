import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_JSON_BODY_LIMIT,
  resolveJsonBodyLimit,
  isPayloadTooLarge,
  payloadTooLargeHandler,
} from "../api/bodyLimit.js";

describe("BRAIN-BODY-LIMIT — resolveJsonBodyLimit", () => {
  it("defaults to 16mb (well above body-parser's 100kb stock limit)", () => {
    expect(resolveJsonBodyLimit({})).toBe(DEFAULT_JSON_BODY_LIMIT);
    expect(DEFAULT_JSON_BODY_LIMIT).toBe("16mb");
  });

  it("honours BRAINROUTER_MAX_BODY_SIZE when set", () => {
    expect(resolveJsonBodyLimit({ BRAINROUTER_MAX_BODY_SIZE: "32mb" })).toBe("32mb");
  });

  it("falls back to the default for empty / whitespace env", () => {
    expect(resolveJsonBodyLimit({ BRAINROUTER_MAX_BODY_SIZE: "   " })).toBe(DEFAULT_JSON_BODY_LIMIT);
    expect(resolveJsonBodyLimit({ BRAINROUTER_MAX_BODY_SIZE: "" })).toBe(DEFAULT_JSON_BODY_LIMIT);
  });
});

describe("BRAIN-BODY-LIMIT — isPayloadTooLarge", () => {
  it("recognises body-parser's PayloadTooLargeError shapes", () => {
    expect(isPayloadTooLarge({ type: "entity.too.large" })).toBe(true);
    expect(isPayloadTooLarge({ status: 413 })).toBe(true);
    expect(isPayloadTooLarge({ statusCode: 413 })).toBe(true);
  });

  it("ignores unrelated errors / non-objects", () => {
    expect(isPayloadTooLarge(new Error("boom"))).toBe(false);
    expect(isPayloadTooLarge({ status: 400 })).toBe(false);
    expect(isPayloadTooLarge(null)).toBe(false);
    expect(isPayloadTooLarge("nope")).toBe(false);
  });
});

describe("BRAIN-BODY-LIMIT — payloadTooLargeHandler", () => {
  it("maps an oversized-body error to a clean 413 and does NOT call next", () => {
    const handler = payloadTooLargeHandler("16mb");
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const res = { status, json, headersSent: false } as unknown as express.Response;
    const next = vi.fn();

    handler({ type: "entity.too.large" }, {} as express.Request, res, next);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledTimes(1);
    const body = json.mock.calls[0][0];
    expect(body).toMatchObject({ error: "Request entity too large", limit: "16mb" });
    expect(body.hint).toContain("BRAINROUTER_MAX_BODY_SIZE");
    expect(next).not.toHaveBeenCalled();
  });

  it("passes unrelated errors through to the next handler", () => {
    const handler = payloadTooLargeHandler("16mb");
    const status = vi.fn();
    const res = { status, headersSent: false } as unknown as express.Response;
    const next = vi.fn();
    const err = new Error("some other failure");

    handler(err, {} as express.Request, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(status).not.toHaveBeenCalled();
  });

  it("does not double-send when headers were already flushed", () => {
    const handler = payloadTooLargeHandler("16mb");
    const status = vi.fn();
    const res = { status, headersSent: true } as unknown as express.Response;
    const next = vi.fn();

    handler({ status: 413 }, {} as express.Request, res, next);

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("BRAIN-BODY-LIMIT — integration (real express + fetch)", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  async function startApp(limit: string): Promise<string> {
    const app = express();
    app.use(express.json({ limit }));
    app.post("/echo", (req, res) => {
      res.json({ ok: true, bytes: JSON.stringify(req.body).length });
    });
    app.use(payloadTooLargeHandler(limit));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("accepts a body under the limit (200)", async () => {
    const baseUrl = await startApp("1kb");
    const res = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg: "small" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("returns a clean 413 (not a crash) when the body exceeds the limit", async () => {
    const baseUrl = await startApp("1kb");
    const huge = "x".repeat(5000); // ~5kb payload vs the 1kb limit
    const res = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blob: huge }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body).toMatchObject({ error: "Request entity too large", limit: "1kb" });
    // the server is still up — a subsequent normal request still succeeds
    const ok = await fetch(`${baseUrl}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg: "after" }),
    });
    expect(ok.status).toBe(200);
  });
});

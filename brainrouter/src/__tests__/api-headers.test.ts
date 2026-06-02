import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveCorsAllowlist,
  isOriginAllowed,
  corsMiddleware,
  securityHeaders,
} from "../api/middleware/securityHeaders.js";

describe("API-HEADERS-CORS — resolveCorsAllowlist", () => {
  it("defaults, splits comma lists, trims whitespace", () => {
    expect(resolveCorsAllowlist({})).toEqual(["http://localhost:3000"]);
    expect(resolveCorsAllowlist({ BRAINROUTER_CORS_ORIGIN: "https://a.test, https://b.test" })).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
  });
});

describe("API-HEADERS-CORS — isOriginAllowed", () => {
  it("matches allowlist exactly, honors wildcard, rejects missing/foreign", () => {
    expect(isOriginAllowed("https://a.test", ["https://a.test"])).toBe(true);
    expect(isOriginAllowed("https://evil.test", ["https://a.test"])).toBe(false);
    expect(isOriginAllowed(undefined, ["https://a.test"])).toBe(false);
    expect(isOriginAllowed("https://anything.test", ["*"])).toBe(true);
  });
});

describe("API-HEADERS-CORS — middleware integration", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function start(): Promise<string> {
    const app = express();
    app.use(securityHeaders({ production: true }));
    app.use(corsMiddleware(["https://app.test"]));
    app.get("/x", (_req, res) => res.json({ ok: true }));
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("reflects an allowed Origin + sets security headers", async () => {
    const base = await start();
    const res = await fetch(`${base}/x`, { headers: { Origin: "https://app.test" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors");
  });

  it("does NOT reflect a foreign Origin", async () => {
    const base = await start();
    const res = await fetch(`${base}/x`, { headers: { Origin: "https://evil.test" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects a disallowed preflight (403) but allows an allowed one (204)", async () => {
    const base = await start();
    const evil = await fetch(`${base}/x`, { method: "OPTIONS", headers: { Origin: "https://evil.test" } });
    expect(evil.status).toBe(403);
    const ok = await fetch(`${base}/x`, { method: "OPTIONS", headers: { Origin: "https://app.test" } });
    expect(ok.status).toBe(204);
  });

  it("lets a no-Origin request (curl / server-to-server) through", async () => {
    const base = await start();
    const res = await fetch(`${base}/x`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

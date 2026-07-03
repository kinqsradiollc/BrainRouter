import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

// API-AUTHN (0.4.9) — fail-closed JWT secret + /me must not leak the API key.

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserById: vi.fn(() => ({
      userId: "u1",
      displayName: "Devon Okafor",
      email: "devon@brainrouter.test",
      isAdmin: false,
      apiKey: "br_super_secret_key_value",
      createdAt: "2026-06-02T00:00:00.000Z",
      status: "active",
    })),
  },
}));

import { jwtSecretBootError, JWT_SECRET, bearerFrom } from "../api/middleware/auth.js";
import type { AuthedRequest } from "../api/middleware/auth.js";
import { authRouter } from "../api/routes/identity/auth.js";
import { signJwt } from "../api/auth/crypto.js";

describe("API-AUTHN — bearerFrom (shared header extraction)", () => {
  const mk = (authorization?: string) => ({ headers: { authorization } }) as unknown as AuthedRequest;
  it("extracts the trimmed token from a Bearer header", () => {
    expect(bearerFrom(mk("Bearer  tok123 "))).toBe("tok123");
  });
  it("returns empty for a missing or non-bearer header", () => {
    expect(bearerFrom(mk(undefined))).toBe("");
    expect(bearerFrom(mk("Basic abc"))).toBe("");
    expect(bearerFrom(mk(""))).toBe("");
  });
});

describe("API-AUTHN — jwtSecretBootError (fail closed in production)", () => {
  it("errors only when production AND using the fallback secret", () => {
    expect(jwtSecretBootError(true, true)).toMatch(/BRAINROUTER_JWT_SECRET is required/);
    expect(jwtSecretBootError(true, false)).toBeNull(); // prod, configured → ok
    expect(jwtSecretBootError(false, true)).toBeNull(); // dev, fallback → ok (warn only)
    expect(jwtSecretBootError(false, false)).toBeNull();
  });
});

describe("API-AUTHN — GET /me omits the raw API key", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("returns the profile but never the apiKey", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    const { port } = server!.address() as AddressInfo;
    const jwt = signJwt({ userId: "u1", isAdmin: false, email: "devon@brainrouter.test" }, JWT_SECRET, 3600);

    const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("u1");
    expect(body.displayName).toBe("Devon Okafor");
    expect(body.apiKey).toBeUndefined(); // the fix: no key in /me
    expect(JSON.stringify(body)).not.toContain("br_super_secret_key_value");
  });
});

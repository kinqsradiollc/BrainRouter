import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// API-AUTHN (0.4.9) — fail-closed JWT secret + /me must not leak the API key.

const authMocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getUserByApiKey: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserById: authMocks.getUserById,
    getUserByApiKey: authMocks.getUserByApiKey,
  },
}));

import { jwtSecretBootError, JWT_SECRET, bearerFrom, requireActiveAnyAuth } from "../api/middleware/auth.js";
import type { AuthedRequest } from "../api/middleware/auth.js";
import { authRouter } from "../api/routes/identity/auth.js";
import { signJwt } from "../api/auth/crypto.js";

const activeUser = {
  userId: "u1",
  displayName: "Devon Okafor",
  email: "devon@brainrouter.test",
  isAdmin: false,
  apiKey: "br_super_secret_key_value",
  passwordHash: null,
  createdAt: "2026-06-02T00:00:00.000Z",
  status: "active" as const,
};

beforeEach(() => {
  authMocks.getUserById.mockReset().mockResolvedValue(activeUser);
  authMocks.getUserByApiKey.mockReset().mockResolvedValue(activeUser);
});

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

describe("API-AUTHN — live guard rejects credentials after account disablement", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function requestWith(credential: string): Promise<Response> {
    const app = express();
    app.get("/protected", requireActiveAnyAuth, (req: AuthedRequest, res) => {
      res.json({ userId: req.userId, isAdmin: req.isAdmin });
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server!.address() as AddressInfo;
    return fetch(`http://127.0.0.1:${port}/protected`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
  }

  it("re-loads a JWT user and refuses a now-disabled account", async () => {
    authMocks.getUserById.mockResolvedValue({ ...activeUser, status: "disabled" });
    const jwt = signJwt({ userId: "u1", isAdmin: true, email: "stale@example.test" }, JWT_SECRET, 3600);
    const response = await requestWith(jwt);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "Account disabled" });
  });

  it("uses the current database identity rather than stale JWT role claims", async () => {
    const jwt = signJwt({ userId: "u1", isAdmin: true, email: "stale@example.test" }, JWT_SECRET, 3600);
    const response = await requestWith(jwt);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "u1", isAdmin: false });
  });

  it("also refuses an API key whose account is now disabled", async () => {
    authMocks.getUserByApiKey.mockResolvedValue({ ...activeUser, status: "disabled" });
    const response = await requestWith("br_disabled_account_key");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "Account disabled" });
  });
});

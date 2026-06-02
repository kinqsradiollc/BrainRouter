import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signJwt } from "../api/auth/crypto.js";
import { JWT_SECRET } from "../api/middleware/auth.js";

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserById: vi.fn((id: string) =>
      id === "user-1"
        ? { userId: "user-1", isAdmin: false, email: "u@test.local", displayName: "U", status: "active" }
        : null,
    ),
    getUserByEmail: vi.fn(() => null),
  },
}));

describe("AUTH-REFRESH — /api/auth/refresh + /signout", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function start(): Promise<string> {
    const { authRouter } = await import("../api/routes/auth.js");
    const app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  const post = (base: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const refreshToken = (userId = "user-1") => signJwt({ userId, type: "refresh" }, JWT_SECRET, 3600);

  it("mints a fresh access + refresh token from a valid refresh token", async () => {
    const base = await start();
    const res = await post(base, "/api/auth/refresh", { refreshToken: refreshToken() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.jwt).toBe("string");
    expect(body.jwt.length).toBeGreaterThan(20);
    expect(typeof body.refreshToken).toBe("string");
    expect(body.jwt).not.toBe(body.refreshToken);
  });

  it("rejects a non-refresh (access) token with 401", async () => {
    const base = await start();
    const access = signJwt({ userId: "user-1" }, JWT_SECRET, 3600); // no type: "refresh"
    const res = await post(base, "/api/auth/refresh", { refreshToken: access });
    expect(res.status).toBe(401);
  });

  it("rejects a garbage / forged token with 401", async () => {
    const base = await start();
    expect((await post(base, "/api/auth/refresh", { refreshToken: "not.a.jwt" })).status).toBe(401);
    const forged = signJwt({ userId: "user-1", type: "refresh" }, "wrong-secret", 3600);
    expect((await post(base, "/api/auth/refresh", { refreshToken: forged })).status).toBe(401);
  });

  it("rejects a refresh token for an unknown user with 401", async () => {
    const base = await start();
    const res = await post(base, "/api/auth/refresh", { refreshToken: refreshToken("ghost") });
    expect(res.status).toBe(401);
  });

  it("400s when no refresh token is supplied", async () => {
    const base = await start();
    expect((await post(base, "/api/auth/refresh", {})).status).toBe(400);
  });

  it("signout returns success (stateless)", async () => {
    const base = await start();
    const res = await post(base, "/api/auth/signout", {});
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});

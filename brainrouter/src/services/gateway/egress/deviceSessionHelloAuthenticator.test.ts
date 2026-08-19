import { describe, expect, it } from "vitest";
import { hashDeviceRefreshToken, type DeviceSessionRecord } from "../../../remote/store.js";
import {
  createDeviceSessionHelloAuthenticator,
  type DeviceSessionLookup,
} from "./deviceSessionHelloAuthenticator.js";

const ORG = "org_1";
const USER = "user_1";
const DEVICE = "device_abc";
const TOKEN = "device-refresh-token-with-enough-entropy-0123456789";
const TOKEN_HASH = hashDeviceRefreshToken(TOKEN);

function makeSession(overrides: Partial<DeviceSessionRecord> = {}): DeviceSessionRecord {
  return {
    id: "sess_1",
    familyId: "fam_1",
    orgId: ORG,
    userId: USER,
    deviceId: DEVICE,
    generation: 1,
    parentSessionId: null,
    replacedBySessionId: null,
    expiresAt: "2999-01-01T00:00:00.000Z",
    rotatedAt: null,
    reuseDetectedAt: null,
    revokedAt: null,
    revocationReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A store that returns `session` only when (org,user,hash) all match. */
function storeFor(session: DeviceSessionRecord | null, hash = TOKEN_HASH): DeviceSessionLookup {
  return {
    async getDeviceSessionByTokenHash(orgId, userId, tokenHash) {
      if (!session) return null;
      if (orgId !== session.orgId || userId !== session.userId || tokenHash !== hash) return null;
      return session;
    },
  };
}

const hello = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "hello",
  orgId: ORG,
  userId: USER,
  deviceId: DEVICE,
  deviceToken: TOKEN,
  ...over,
});

describe("createDeviceSessionHelloAuthenticator (C4 follow-up)", () => {
  it("admits a hello whose token maps to a live session for the presented device", async () => {
    const auth = createDeviceSessionHelloAuthenticator({ store: storeFor(makeSession()) });
    await expect(auth(hello())).resolves.toEqual({ orgId: ORG, userId: USER, deviceId: DEVICE });
  });

  it("rejects when the presented deviceId does not match the session's device (spoof)", async () => {
    const auth = createDeviceSessionHelloAuthenticator({ store: storeFor(makeSession()) });
    // Valid token for DEVICE, but the hello claims a different deviceId.
    await expect(auth(hello({ deviceId: "device_other" }))).resolves.toBeNull();
  });

  it("rejects a revoked session", async () => {
    const auth = createDeviceSessionHelloAuthenticator({
      store: storeFor(makeSession({ revokedAt: "2026-01-02T00:00:00.000Z" })),
    });
    await expect(auth(hello())).resolves.toBeNull();
  });

  it("rejects a reuse-flagged session", async () => {
    const auth = createDeviceSessionHelloAuthenticator({
      store: storeFor(makeSession({ reuseDetectedAt: "2026-01-02T00:00:00.000Z" })),
    });
    await expect(auth(hello())).resolves.toBeNull();
  });

  it("rejects an expired session (now override)", async () => {
    const auth = createDeviceSessionHelloAuthenticator({
      store: storeFor(makeSession({ expiresAt: "2026-01-01T00:00:00.000Z" })),
      now: () => Date.parse("2026-06-01T00:00:00.000Z"),
    });
    await expect(auth(hello())).resolves.toBeNull();
  });

  it("fails closed on an unparseable expiry (does not admit on NaN)", async () => {
    const auth = createDeviceSessionHelloAuthenticator({
      store: storeFor(makeSession({ expiresAt: "not-a-date" })),
    });
    await expect(auth(hello())).resolves.toBeNull();
  });

  it("rejects a hello missing required fields", async () => {
    const auth = createDeviceSessionHelloAuthenticator({ store: storeFor(makeSession()) });
    await expect(auth(hello({ deviceToken: undefined }))).resolves.toBeNull();
    await expect(auth(hello({ orgId: "" }))).resolves.toBeNull();
    await expect(auth({ kind: "hello" })).resolves.toBeNull();
  });

  it("rejects a malformed (too-short) token without throwing", async () => {
    const auth = createDeviceSessionHelloAuthenticator({ store: storeFor(makeSession()) });
    await expect(auth(hello({ deviceToken: "short" }))).resolves.toBeNull();
  });

  it("rejects an unknown token (no session found)", async () => {
    const auth = createDeviceSessionHelloAuthenticator({ store: storeFor(makeSession()) });
    await expect(auth(hello({ deviceToken: "a-different-but-long-enough-token-abcdef" }))).resolves.toBeNull();
  });

  it("does not leak another user's session (org/user scoping)", async () => {
    // Store only holds a session for (ORG, USER); a hello for a different user
    // presenting the same token must not resolve to it.
    const auth = createDeviceSessionHelloAuthenticator({ store: storeFor(makeSession()) });
    await expect(auth(hello({ userId: "user_2" }))).resolves.toBeNull();
    await expect(auth(hello({ orgId: "org_2" }))).resolves.toBeNull();
  });
});

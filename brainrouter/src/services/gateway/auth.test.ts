import { describe, expect, it, vi } from "vitest";

import { signJwt } from "../../api/auth/crypto.js";
import {
  MODEL_GATEWAY_AUDIENCE,
  MODEL_INVOKE_SCOPE,
  authenticateGatewayCredential,
  type GatewayIdentityStore,
} from "./auth.js";

const secret = "gateway-test-secret";

function store(overrides: Partial<GatewayIdentityStore> = {}): GatewayIdentityStore {
  return {
    getUserByApiKey: vi.fn(async (apiKey) => apiKey === "br_active" ? {
      userId: "user-1",
      status: "active" as const,
    } : null),
    getUserById: vi.fn(async (userId) => userId === "user-1" ? {
      userId,
      status: "active" as const,
    } : null),
    getDefaultOrgId: vi.fn(async () => "org-1"),
    getMemberRole: vi.fn(async (orgId, userId) => (
      orgId === "org-1" && userId === "user-1" ? "developer" : null
    )),
    getServicePrincipal: vi.fn(async (id) => id === "svc-brain" ? {
      id,
      orgId: "org-1",
      active: true,
      scopes: [MODEL_INVOKE_SCOPE],
    } : null),
    ...overrides,
  };
}

function accessToken(overrides: Record<string, unknown> = {}): string {
  return signJwt({
    type: "access",
    aud: ["brainrouter-api", MODEL_GATEWAY_AUDIENCE],
    scope: ["api", MODEL_INVOKE_SCOPE],
    userId: "user-1",
    ...overrides,
  }, secret, 600);
}

describe("model gateway credential authentication", () => {
  it("resolves a JWT organization only after active-user and current-membership checks", async () => {
    await expect(authenticateGatewayCredential({
      bearer: accessToken(),
      requestedOrgId: "org-1",
      jwtSecret: secret,
      store: store(),
    })).resolves.toEqual({
      credentialType: "jwt",
      principalType: "user",
      userId: "user-1",
      orgId: "org-1",
      role: "developer",
      scopes: ["api", MODEL_INVOKE_SCOPE],
    });
  });

  it("rejects refresh tokens, missing/wrong audience, and missing invoke scope", async () => {
    for (const bearer of [
      signJwt({ type: "refresh", userId: "user-1", aud: MODEL_GATEWAY_AUDIENCE, scope: MODEL_INVOKE_SCOPE }, secret, 600),
      accessToken({ aud: "brainrouter-api" }),
      accessToken({ aud: undefined }),
      accessToken({ scope: "api" }),
      accessToken({ scope: undefined }),
    ]) {
      await expect(authenticateGatewayCredential({ bearer, jwtSecret: secret, store: store() }))
        .rejects.toMatchObject({ status: 401, code: "invalid_credential" });
    }
  });

  it("fails closed for disabled users and stale or cross-organization membership", async () => {
    await expect(authenticateGatewayCredential({
      bearer: accessToken(),
      jwtSecret: secret,
      store: store({ getUserById: vi.fn(async () => ({ userId: "user-1", status: "disabled" as const })) }),
    })).rejects.toMatchObject({ status: 403, code: "account_disabled" });

    await expect(authenticateGatewayCredential({
      bearer: accessToken(),
      requestedOrgId: "org-2",
      jwtSecret: secret,
      store: store(),
    })).rejects.toMatchObject({ status: 403, code: "organization_forbidden" });
  });

  it("accepts an active API key but still resolves and verifies organization membership", async () => {
    await expect(authenticateGatewayCredential({
      bearer: "br_active",
      requestedOrgId: "org-1",
      jwtSecret: secret,
      store: store(),
    })).resolves.toMatchObject({
      credentialType: "api_key",
      principalType: "user",
      userId: "user-1",
      orgId: "org-1",
      role: "developer",
      scopes: [MODEL_INVOKE_SCOPE],
    });
  });

  it("accepts only an active, persisted internal service principal with matching org and scope", async () => {
    const token = signJwt({
      type: "service",
      aud: MODEL_GATEWAY_AUDIENCE,
      scope: MODEL_INVOKE_SCOPE,
      servicePrincipalId: "svc-brain",
      orgId: "org-1",
    }, secret, 60);

    await expect(authenticateGatewayCredential({
      bearer: token,
      jwtSecret: secret,
      store: store(),
    })).resolves.toEqual({
      credentialType: "internal_service",
      principalType: "service",
      servicePrincipalId: "svc-brain",
      orgId: "org-1",
      scopes: [MODEL_INVOKE_SCOPE],
    });

    await expect(authenticateGatewayCredential({
      bearer: token,
      jwtSecret: secret,
      store: store({ getServicePrincipal: vi.fn(async () => ({
        id: "svc-brain",
        orgId: "org-1",
        active: false,
        scopes: [MODEL_INVOKE_SCOPE],
      })) }),
    })).rejects.toMatchObject({ status: 403, code: "service_principal_forbidden" });
  });
});

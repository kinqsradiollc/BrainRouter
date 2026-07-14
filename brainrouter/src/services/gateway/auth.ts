import { verifyJwt } from "../../api/auth/crypto.js";
import type { Role } from "../../tenancy/rbac.js";

export const MODEL_GATEWAY_AUDIENCE = "brainrouter-model-gateway";
export const MODEL_INVOKE_SCOPE = "models:invoke";

export interface GatewayIdentityStore {
  getUserByApiKey(apiKey: string): Promise<{ userId: string; status: "active" | "disabled" } | null>;
  getUserById(userId: string): Promise<{ userId: string; status: "active" | "disabled" } | null>;
  getDefaultOrgId(userId: string): Promise<string | null>;
  getMemberRole(orgId: string, userId: string): Promise<Role | null>;
  getServicePrincipal(id: string): Promise<{
    id: string;
    orgId: string;
    active: boolean;
    scopes: readonly string[];
  } | null>;
}

export type GatewayAuthContext =
  | {
      credentialType: "jwt" | "api_key";
      principalType: "user";
      userId: string;
      orgId: string;
      role: Role;
      scopes: string[];
    }
  | {
      credentialType: "internal_service";
      principalType: "service";
      servicePrincipalId: string;
      orgId: string;
      scopes: string[];
    };

export class GatewayAuthError extends Error {
  constructor(
    public readonly status: 401 | 403,
    public readonly code:
      | "invalid_credential"
      | "account_disabled"
      | "organization_forbidden"
      | "service_principal_forbidden",
    message: string,
  ) {
    super(message);
    this.name = "GatewayAuthError";
  }
}

function strings(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s+/)
      : [];
  return [...new Set(values.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function hasAudience(payload: Record<string, unknown>): boolean {
  return strings(payload.aud).includes(MODEL_GATEWAY_AUDIENCE);
}

function hasInvokeScope(scopes: readonly string[]): boolean {
  return scopes.includes(MODEL_INVOKE_SCOPE);
}

async function resolveUserContext(input: {
  userId: string;
  credentialType: "jwt" | "api_key";
  scopes: string[];
  requestedOrgId?: string;
  store: GatewayIdentityStore;
}): Promise<GatewayAuthContext> {
  const user = await input.store.getUserById(input.userId);
  if (!user) {
    throw new GatewayAuthError(401, "invalid_credential", "The access credential is not valid.");
  }
  if (user.status !== "active") {
    throw new GatewayAuthError(403, "account_disabled", "The account is disabled.");
  }

  const orgId = input.requestedOrgId?.trim() || await input.store.getDefaultOrgId(user.userId);
  if (!orgId) {
    throw new GatewayAuthError(403, "organization_forbidden", "No active organization is available.");
  }
  const role = await input.store.getMemberRole(orgId, user.userId);
  if (!role) {
    throw new GatewayAuthError(403, "organization_forbidden", "The account cannot access this organization.");
  }
  return {
    credentialType: input.credentialType,
    principalType: "user",
    userId: user.userId,
    orgId,
    role,
    scopes: input.scopes,
  };
}

/**
 * Authenticate one data-plane bearer and derive tenant scope from verified
 * identity plus current persistence. A caller may select an organization only
 * through `requestedOrgId`; membership is always re-read and body fields are
 * intentionally outside this contract.
 */
export async function authenticateGatewayCredential(input: {
  bearer: string;
  requestedOrgId?: string;
  jwtSecret: string;
  store: GatewayIdentityStore;
}): Promise<GatewayAuthContext> {
  const bearer = input.bearer.trim();
  if (!bearer) {
    throw new GatewayAuthError(401, "invalid_credential", "An access credential is required.");
  }

  if (bearer.split(".").length !== 3) {
    const user = await input.store.getUserByApiKey(bearer);
    if (!user) {
      throw new GatewayAuthError(401, "invalid_credential", "The access credential is not valid.");
    }
    return resolveUserContext({
      userId: user.userId,
      credentialType: "api_key",
      scopes: [MODEL_INVOKE_SCOPE],
      requestedOrgId: input.requestedOrgId,
      store: input.store,
    });
  }

  const payload = verifyJwt(bearer, input.jwtSecret);
  const scopes = strings(payload?.scope);
  if (!payload || !hasAudience(payload) || !hasInvokeScope(scopes)) {
    throw new GatewayAuthError(401, "invalid_credential", "The access credential is not valid for the model gateway.");
  }

  if (payload.type === "service") {
    const servicePrincipalId = typeof payload.servicePrincipalId === "string"
      ? payload.servicePrincipalId.trim()
      : "";
    const claimedOrgId = typeof payload.orgId === "string" ? payload.orgId.trim() : "";
    const principal = servicePrincipalId
      ? await input.store.getServicePrincipal(servicePrincipalId)
      : null;
    if (
      !principal
      || !principal.active
      || !claimedOrgId
      || principal.orgId !== claimedOrgId
      || (input.requestedOrgId && input.requestedOrgId.trim() !== claimedOrgId)
      || !hasInvokeScope(principal.scopes)
    ) {
      throw new GatewayAuthError(403, "service_principal_forbidden", "The internal service credential is not authorized.");
    }
    return {
      credentialType: "internal_service",
      principalType: "service",
      servicePrincipalId: principal.id,
      orgId: principal.orgId,
      scopes,
    };
  }

  if (payload.type !== "access" || typeof payload.userId !== "string" || !payload.userId.trim()) {
    throw new GatewayAuthError(401, "invalid_credential", "The access credential is not valid.");
  }
  return resolveUserContext({
    userId: payload.userId,
    credentialType: "jwt",
    scopes,
    requestedOrgId: input.requestedOrgId,
    store: input.store,
  });
}

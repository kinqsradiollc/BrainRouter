import type { Request, Response, NextFunction } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { randomBytes } from "node:crypto";
import { verifyJwt } from "../auth/crypto.js";
import { sendError } from "../../contracts/http.js";

export type AuthedRequest = Request & { userId?: string; isAdmin?: boolean; email?: string };

/**
 * Extract the bearer credential from the `Authorization` header (the one piece
 * every auth guard below shares). Returns `""` when absent or non-bearer. Pure
 * (no engine, no I/O) so it is unit-testable in isolation.
 */
export function bearerFrom(req: AuthedRequest): string {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/** Look the API-key user up and attach identity to the request. */
function attachApiKeyUser(req: AuthedRequest, key: string): boolean {
  const user = memoryEngine.getUserByApiKey(key);
  if (!user) return false;
  req.userId = user.userId;
  req.isAdmin = user.isAdmin;
  req.email = user.email;
  return true;
}

const configuredJwtSecret = process.env.BRAINROUTER_JWT_SECRET?.trim();
const generatedJwtSecret = randomBytes(32).toString("hex");
export const USING_FALLBACK_JWT_SECRET = !configuredJwtSecret;
export const JWT_SECRET = configuredJwtSecret || generatedJwtSecret;
export const IS_PRODUCTION = (process.env.NODE_ENV ?? "").toLowerCase() === "production";

/**
 * API-AUTHN (0.4.9) — fail closed on a missing JWT secret in production. Pure
 * (unit-testable); the boot path throws on a non-null result. In development we
 * only warn — a random per-boot secret is fine for local sessions.
 */
export function jwtSecretBootError(isProd: boolean, usingFallback: boolean): string | null {
  if (isProd && usingFallback) {
    return "BRAINROUTER_JWT_SECRET is required in production (NODE_ENV=production) — refusing to start with a random, non-persistent secret.";
  }
  return null;
}

if (USING_FALLBACK_JWT_SECRET) {
  console.error("[BrainRouter] WARNING: BRAINROUTER_JWT_SECRET not set. Using random secret — sessions will not survive restarts.");
}

// AUTH-GUARDS — three guards with intentionally divergent security semantics,
// not one factory: `requireAuth` is API-key-only, `requireJwt` re-checks the
// user in the DB + the disabled flag, and `requireAnyAuth` deliberately TRUSTS a
// valid JWT payload without that re-check (its API-key branch reuses
// `attachApiKeyUser`). They share `bearerFrom` + the `{ error, code }` envelope.

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const key = bearerFrom(req);
  if (!key) {
    sendError(res, 401, "API key required");
    return;
  }
  if (!attachApiKeyUser(req, key)) {
    sendError(res, 403, "Invalid API key");
    return;
  }
  next();
}

export function requireJwt(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = bearerFrom(req);
  if (!token) {
    sendError(res, 401, "JWT required");
    return;
  }
  const payload = verifyJwt(token, JWT_SECRET);
  if (!payload) {
    sendError(res, 401, "Invalid or expired token");
    return;
  }
  req.userId = typeof payload.userId === "string" ? payload.userId : undefined;
  req.isAdmin = Boolean(payload.isAdmin);
  req.email = typeof payload.email === "string" ? payload.email : undefined;
  if (!req.userId) {
    sendError(res, 401, "Invalid or expired token");
    return;
  }
  const user = memoryEngine.getUserById(req.userId);
  if (!user) {
    sendError(res, 401, "Invalid or expired token");
    return;
  }
  if (user.status === "disabled") {
    sendError(res, 403, "Account disabled");
    return;
  }
  next();
}

export function requireAnyAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const bearer = bearerFrom(req);
  if (!bearer) {
    sendError(res, 401, "Authentication required");
    return;
  }

  if (bearer.split(".").length === 3) {
    const payload = verifyJwt(bearer, JWT_SECRET);
    if (payload && typeof payload.userId === "string") {
      req.userId = payload.userId;
      req.isAdmin = Boolean(payload.isAdmin);
      req.email = typeof payload.email === "string" ? payload.email : undefined;
      return next();
    }
  }

  if (!attachApiKeyUser(req, bearer)) {
    sendError(res, 401, "Authentication required");
    return;
  }
  next();
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.isAdmin) {
    sendError(res, 403, "Admin access required");
    return;
  }
  next();
}

// RBAC-ENFORCE (0.4.5) — the per-user scoping helpers live in `scope.ts` (no
// memoryEngine import, so they stay pure + unit-testable). Re-exported here so
// routes keep importing scoping + auth from one place.
export { ScopeError, scopedUserId, errorStatus, type ScopeRequest } from "./scope.js";

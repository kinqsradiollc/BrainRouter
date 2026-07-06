/**
 * Tenancy + RBAC middleware (ADR-010 P1/P3).
 *
 * `requirePermission(cap)` is the one enforcement point routes use to gate an
 * action on a capability (e.g. `providers:manage`, `triggers:manage`). It runs
 * AFTER an auth guard (which set `req.userId`): it lazily resolves the caller's
 * org context (`X-BrainRouter-Org` header, else their default org), attaches
 * `req.orgId`/`req.role`, and 403s unless the role holds the capability.
 *
 * Self-contained so a route can just chain `requireAnyAuth, requirePermission(cap)`
 * without a separate org-resolution step.
 */
import type { Response, NextFunction } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { sendError } from "../../contracts/http.js";
import { can, type Capability } from "../../tenancy/rbac.js";
import { resolveOrgContext } from "../../tenancy/context.js";
import type { AuthedRequest } from "./auth.js";

/** Read the requested org from the `X-BrainRouter-Org` header (optional). */
function requestedOrg(req: AuthedRequest): string | undefined {
  const h = req.headers["x-brainrouter-org"];
  const v = (Array.isArray(h) ? h[0] : h)?.trim();
  return v || undefined;
}

/**
 * Attach `{ orgId, role }` to the request from the caller's org context. Assumes
 * an auth guard already set `req.userId`. Returns false (and 403s) when a
 * requested org is not one the caller belongs to.
 */
export async function attachOrgContext(req: AuthedRequest, res: Response): Promise<boolean> {
  if (req.role && req.orgId) return true; // already resolved this request
  if (!req.userId) {
    sendError(res, 401, "Authentication required");
    return false;
  }
  const requested = requestedOrg(req);
  const ctx = await resolveOrgContext(memoryEngine.tenancy, req.userId, requested);
  if (!ctx) {
    sendError(res, 403, "You are not a member of the requested organization");
    return false;
  }
  req.orgId = ctx.orgId;
  req.role = ctx.role;
  return true;
}

/** Express middleware: resolve org context, then require a capability. */
export function requirePermission(cap: Capability) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!(await attachOrgContext(req, res))) return;
    if (!can(req.role, cap)) {
      sendError(res, 403, `This action requires the '${cap}' capability`);
      return;
    }
    next();
  };
}

/** Express middleware: resolve + attach org context without gating a capability. */
export async function withOrgContext(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  if (await attachOrgContext(req, res)) next();
}

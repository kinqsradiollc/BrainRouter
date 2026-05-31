/**
 * RBAC-ENFORCE (0.4.5) — the single source of truth for per-user scoping of
 * API reads/writes. Kept in its own module (no `memoryEngine`/sqlite import) so
 * the rule is pure + unit-testable; `auth.ts` re-exports these so routes keep
 * importing from one place.
 */

/** Minimal shape `scopedUserId` needs from an authenticated request. */
export interface ScopeRequest {
  userId?: string;
  isAdmin?: boolean;
}

/**
 * Thrown when a non-admin requests another user's data. Carries `status = 403`
 * so route catch blocks map it to Forbidden instead of a generic 400/500 (the
 * inconsistency this consolidation removes — the rule was copy-pasted into 4
 * route files, each catching it with a different status).
 */
export class ScopeError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

/**
 * Resolve the effective userId of a scoped read/write. Returns the
 * authenticated user's id by default; a non-empty `requested` that DIFFERS is
 * honored ONLY for admins (cross-user access), otherwise throws `ScopeError`
 * (403). Every route that accepts a `userId` query/body param MUST route it
 * through this so the rule can't drift per-endpoint. `resource` customizes the
 * denial message: "Cannot access another user's <resource>".
 */
export function scopedUserId(req: ScopeRequest, requested?: unknown, resource = "data"): string {
  const requestedUserId = typeof requested === "string" && requested.trim() ? requested.trim() : undefined;
  if (!requestedUserId || requestedUserId === req.userId) return req.userId!;
  if (req.isAdmin) return requestedUserId;
  throw new ScopeError(`Cannot access another user's ${resource}`);
}

/**
 * Pick an HTTP status for a caught route error, honoring a `ScopeError` (or
 * anything carrying a numeric `.status` → e.g. 403), else `fallback`.
 */
export function errorStatus(error: unknown, fallback: number): number {
  const s = (error as { status?: unknown })?.status;
  return typeof s === "number" ? s : fallback;
}

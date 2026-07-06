/**
 * Tenant-context resolver (ADR-010 P1). Given an authenticated `userId` and an
 * optional requested org, resolve the `{ orgId, role }` the request acts under.
 *
 * Rules:
 *  - a requested org the caller is NOT a member of → `null` (the caller gets 403);
 *  - no requested org → the user's `default_org_id`;
 *  - self-heal: a user with no default (pre-migration / freshly created) gets
 *    their personal org ensured, so the local-first path never 500s on a missing
 *    org row.
 */
import type { Role } from "./rbac.js";
import type { TenancyStore } from "./store.js";

export interface OrgContext {
  orgId: string;
  role: Role;
}

export async function resolveOrgContext(
  store: TenancyStore,
  userId: string,
  requestedOrgId?: string,
): Promise<OrgContext | null> {
  const requested = requestedOrgId?.trim();
  if (requested) {
    const role = await store.getMemberRole(requested, userId);
    return role ? { orgId: requested, role } : null; // not a member → caller 403s
  }
  const defaultOrgId = await store.getDefaultOrgId(userId);
  if (defaultOrgId) {
    const role = await store.getMemberRole(defaultOrgId, userId);
    if (role) return { orgId: defaultOrgId, role };
  }
  // Self-heal: ensure the personal org exists (idempotent) and act as its owner.
  const org = await store.ensurePersonalOrg(userId);
  const role = (await store.getMemberRole(org.orgId, userId)) ?? "owner";
  return { orgId: org.orgId, role };
}

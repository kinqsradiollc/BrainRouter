/**
 * RBAC — roles + capabilities for the org tenancy tier (ADR-010 / spec §3).
 *
 * Pure + dependency-free so it unit-tests in isolation and can be shared by the
 * HTTP middleware AND the MCP config-tool gate. A member's role in an
 * organization maps to a fixed set of capabilities; `can(role, cap)` is the one
 * predicate every enforcement point calls.
 *
 * Roles form a total order (owner > admin > member > viewer). A single user is
 * modeled as the sole `owner` of a personal org, so the local-first flow always
 * has every capability and never hits a permission wall.
 */

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Higher = more privilege. Used for "at least this role" comparisons. */
const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

export const CAPABILITIES = [
  'org:manage',       // rename / delete / change plan / transfer ownership
  'members:manage',   // invite / remove members, set roles
  'providers:manage', // create/update/delete LLM/embeddings/reranker/judge configs
  'triggers:manage',  // GitHub App / webhook / automation-rule config
  'memory:write',     // create/update one's own memory records
  'memory:read',      // read own + org-shared memory
  'memory:share',     // mark a record org-visible (private → org)
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Role → capability grants. Deliberately explicit (not derived from rank) so a
 * reviewer can read exactly what each role can do; adding a capability is a
 * conscious per-role decision.
 */
export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  owner: new Set(CAPABILITIES),
  admin: new Set<Capability>([
    'members:manage',
    'providers:manage',
    'triggers:manage',
    'memory:write',
    'memory:read',
    'memory:share',
  ]),
  member: new Set<Capability>(['memory:write', 'memory:read', 'memory:share']),
  viewer: new Set<Capability>(['memory:read']),
};

/** Narrow an unknown value to a {@link Role}. */
export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x);
}

/** True when `role` holds `cap`. Unknown/invalid roles grant nothing. */
export function can(role: Role | string | null | undefined, cap: Capability): boolean {
  if (!isRole(role)) return false;
  return ROLE_CAPABILITIES[role].has(cap);
}

/** True when `role` is at least `min` in the privilege order (owner ≥ admin ≥ member ≥ viewer). */
export function roleAtLeast(role: Role | string | null | undefined, min: Role): boolean {
  if (!isRole(role)) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Every capability `role` holds (stable array, for surfacing in an API/UI). */
export function capabilitiesFor(role: Role | string | null | undefined): Capability[] {
  if (!isRole(role)) return [];
  return CAPABILITIES.filter((c) => ROLE_CAPABILITIES[role].has(c));
}

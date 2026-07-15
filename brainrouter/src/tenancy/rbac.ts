/**
 * RBAC — roles + capabilities for the org tenancy tier (ADR-010 §3, ADR-017 D6).
 *
 * Pure + dependency-free so it unit-tests in isolation and can be shared by the
 * HTTP middleware AND the MCP config-tool gate. A member's role in an
 * organization maps to a fixed set of capabilities; `can(role, cap)` is the one
 * predicate every enforcement point calls.
 *
 * Roles form a total order (owner > admin > developer > viewer). A single user is
 * modeled as the sole `owner` of a personal org, so the local-first flow always
 * has every capability and never hits a permission wall.
 *
 * ADR-017 D6 renamed `member` → `developer`. Rows/tokens written before the rename
 * still say `member`; `normalizeRole` maps them to `developer`, so `can` / `roleAtLeast`
 * / `capabilitiesFor` stay backward-compatible with zero data migration.
 */

export const ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Legacy role names → canonical Role (ADR-017 D6 rename). */
const LEGACY_ROLE_ALIASES: Record<string, Role> = { member: 'developer', manager: 'admin' };

/** Higher = more privilege. Used for "at least this role" comparisons. */
const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, developer: 1, viewer: 0 };

export const CAPABILITIES = [
  'org:manage',       // rename / delete / change plan / transfer ownership
  'members:manage',   // invite / remove members, set roles
  'providers:manage', // create/update/delete LLM/embeddings/reranker configs
  'models:read',      // read the member-safe server-managed model catalog
  'models:manage',    // create/update/default/order org model policies
  'triggers:manage',  // GitHub App / webhook / automation-rule config + linked repos
  'reviews:read',     // PR review console, job details and live timelines
  'reviews:run',      // manually enqueue a security/code review
  'remote:read',      // list one's enrolled devices, grants, and metadata audit
  'remote:connect',   // request remote sessions within an approved device grant
  'remote:manage',    // approve/revoke device grants and enrolled devices
  'memory:write',     // create/update one's own memory records
  'memory:read',      // read own + org-shared memory
  'memory:share',     // mark a record org-visible (private → org)
  'vulnerabilities:read',   // browse the CVE catalog + this org's scans/findings
  'vulnerabilities:scan',   // run repository inventory scans + OSV matching
  'vulnerabilities:manage', // refresh sources, triage findings, manage watches
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
    'models:read',
    'models:manage',
    'triggers:manage',
    'reviews:read',
    'reviews:run',
    'remote:read',
    'remote:connect',
    'remote:manage',
    'memory:write',
    'memory:read',
    'memory:share',
    'vulnerabilities:read',
    'vulnerabilities:scan',
    'vulnerabilities:manage',
  ]),
  developer: new Set<Capability>([
    'models:read',
    'reviews:read',
    'remote:read',
    'remote:connect',
    'remote:manage',
    'memory:write',
    'memory:read',
    'memory:share',
    'vulnerabilities:read',
    'vulnerabilities:scan',
  ]),
  viewer: new Set<Capability>(['models:read', 'remote:read', 'memory:read', 'vulnerabilities:read']),
};

/** Narrow an unknown value to a canonical {@link Role} (strict — no legacy names). */
export function isRole(x: unknown): x is Role {
  return typeof x === 'string' && (ROLES as readonly string[]).includes(x);
}

/**
 * Resolve a stored/legacy role string to a canonical {@link Role}, mapping the
 * pre-D6 names (`member` → `developer`, `manager` → `admin`). Returns null for
 * anything unrecognized. Every enforcement predicate runs through this so old and
 * new role values are treated identically.
 */
export function normalizeRole(x: unknown): Role | null {
  if (isRole(x)) return x;
  if (typeof x === 'string' && x in LEGACY_ROLE_ALIASES) return LEGACY_ROLE_ALIASES[x];
  return null;
}

/** True when `role` holds `cap`. Unknown/invalid roles grant nothing. */
export function can(role: Role | string | null | undefined, cap: Capability): boolean {
  const r = normalizeRole(role);
  return r ? ROLE_CAPABILITIES[r].has(cap) : false;
}

/** True when `role` is at least `min` in the privilege order (owner ≥ admin ≥ developer ≥ viewer). */
export function roleAtLeast(role: Role | string | null | undefined, min: Role): boolean {
  const r = normalizeRole(role);
  return r ? ROLE_RANK[r] >= ROLE_RANK[min] : false;
}

/** Every capability `role` holds (stable array, for surfacing in an API/UI). */
export function capabilitiesFor(role: Role | string | null | undefined): Capability[] {
  const r = normalizeRole(role);
  return r ? CAPABILITIES.filter((c) => ROLE_CAPABILITIES[r].has(c)) : [];
}

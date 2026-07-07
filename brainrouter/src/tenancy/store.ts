/**
 * TenancyStore — the org/membership persistence surface (ADR-010 P1).
 *
 * Kept BACKEND-LOCAL (not in the shared `@kinqs/brainrouter-types` `IMemoryStore`,
 * which desktop/CLI also consume and which has no notion of organizations). The
 * concrete `PostgresMemoryStore` implements this alongside `IMemoryStore`; the
 * engine surfaces it via `memoryEngine.tenancy` so routes/resolvers never reach
 * into store internals.
 */
import type { Role } from "./rbac.js";
import type { OrganizationRecord, OrgMemberRecord, OrgMembership, OrgPlan } from "./types.js";

export interface TenancyStore {
  createOrganization(input: { orgId: string; name: string; slug: string; plan?: OrgPlan }): Promise<OrganizationRecord>;
  getOrganization(orgId: string): Promise<OrganizationRecord | null>;
  /** Change an org's plan tier (owner-gated at the route). Returns the updated record. */
  updateOrganizationPlan(orgId: string, plan: OrgPlan): Promise<OrganizationRecord>;
  /** Set the org's email-domain allowlist (owner + enterprise-gated). Returns the updated record. */
  updateAllowedDomains(orgId: string, domains: string[]): Promise<OrganizationRecord>;
  addOrgMember(orgId: string, userId: string, role: Role): Promise<void>;
  removeOrgMember(orgId: string, userId: string): Promise<void>;
  getMemberRole(orgId: string, userId: string): Promise<Role | null>;
  listOrgMembers(orgId: string): Promise<OrgMemberRecord[]>;
  listOrgMembershipsForUser(userId: string): Promise<OrgMembership[]>;
  setDefaultOrg(userId: string, orgId: string): Promise<void>;
  getDefaultOrgId(userId: string): Promise<string | null>;
  /** Idempotently ensure a user's personal org (owner) + default. */
  ensurePersonalOrg(userId: string, displayName?: string): Promise<OrganizationRecord>;
}

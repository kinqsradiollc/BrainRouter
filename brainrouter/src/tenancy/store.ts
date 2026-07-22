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
import type { AuthTokenRecord, OrgInviteRecord } from "../memory/store/postgres/queries/emailAuthQueries.js";
import type { OrgIdentityRecord } from "../memory/store/postgres/queries/orgPersonaQueries.js";
import type { SharedMemory } from "../memory/store/postgres/queries/memorySharingQueries.js";
import type { ProjectRecord, ProjectMemberRecord } from "../memory/store/postgres/queries/projectQueries.js";
import type { OrgStatsRow, OrgAuditRow } from "../memory/store/postgres/queries/adminConsoleQueries.js";

export type { ProjectRecord, ProjectMemberRecord } from "../memory/store/postgres/queries/projectQueries.js";

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

/**
 * Email/auth persistence (ADR-014 Phase B2) — system settings (SMTP config),
 * single-use auth tokens (email verification + password reset) and org
 * invitations. Exposed via `memoryEngine.emailAuth` (a localized cast, like
 * `tenancy`), since the shared `IMemoryStore` type has no notion of these.
 */
export interface EmailAuthStore {
  getSetting<T = unknown>(key: string): Promise<T | null>;
  setSetting(key: string, value: unknown): Promise<void>;
  createAuthToken(rec: { tokenHash: string; kind: string; userId?: string | null; email?: string | null; expiresAt: string; createdAt: string }): Promise<void>;
  consumeAuthToken(tokenHash: string, kind: string, nowIso: string): Promise<AuthTokenRecord | null>;
  setEmailVerified(userId: string): Promise<void>;
  createInvite(rec: OrgInviteRecord): Promise<void>;
  getInviteByHash(tokenHash: string): Promise<OrgInviteRecord | null>;
  acceptInvite(tokenHash: string, nowIso: string): Promise<OrgInviteRecord | null>;
  listInvites(orgId: string): Promise<OrgInviteRecord[]>;
  revokeInvite(tokenHash: string): Promise<void>;
}

/** Team consensus-persona store (ADR-014 Phase C), via `memoryEngine.orgPersona`. */
export interface OrgPersonaStore {
  getOrgSharedIdentityCognitives(orgId: string, limit?: number): Promise<any[]>;
  getOrgIdentity(orgId: string): Promise<OrgIdentityRecord | null>;
  upsertOrgIdentity(rec: OrgIdentityRecord): Promise<void>;
}

/** Artifact/memory sharing (ADR-014 Phase D), via `memoryEngine.sharing`. */
export interface MemorySharingStore {
  setMemoryVisibility(recordId: string, userId: string, orgId: string, visibility: "private" | "team" | "org", teamId?: string | null): Promise<boolean>;
  listOrgSharedMemories(orgId: string, limit?: number): Promise<SharedMemory[]>;
}

/** Projects + per-project access control (ADR-014 Phase E), via `memoryEngine.projects`. */
export interface ProjectStore {
  createProject(rec: ProjectRecord): Promise<void>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  getAccessibleProject(projectId: string, orgId: string, userId: string, canAccessRestricted: boolean): Promise<ProjectRecord | null>;
  countProjects(orgId: string): Promise<number>;
  updateProject(projectId: string, patch: { name?: string; repoUrl?: string | null; restricted?: boolean }): Promise<ProjectRecord | null>;
  deleteProject(projectId: string): Promise<void>;
  listAccessibleProjects(orgId: string, userId: string, isOrgAdmin: boolean): Promise<ProjectRecord[]>;
  addProjectMember(projectId: string, userId: string, role: string, now: string): Promise<void>;
  removeProjectMember(projectId: string, userId: string): Promise<void>;
  listProjectMembers(projectId: string): Promise<ProjectMemberRecord[]>;
}

/** Admin console + audit trail (ADR-014 Phase F), via `memoryEngine.adminConsole`. */
export interface AdminConsoleStore {
  listAllOrgsWithStats(limit?: number): Promise<OrgStatsRow[]>;
  logOrgAudit(rec: { orgId: string; actorId?: string | null; action: string; target?: string | null; detail?: string | null; createdAt: string }): Promise<void>;
  listOrgAudit(orgId: string, limit?: number): Promise<OrgAuditRow[]>;
}

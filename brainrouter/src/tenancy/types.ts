/**
 * Tenancy records (ADR-010 P1). The organization tier above the existing user.
 */
import type { Role } from "./rbac.js";

export type OrgPlan = "single" | "team" | "enterprise";

export interface OrganizationRecord {
  orgId: string;
  name: string;
  slug: string;
  plan: OrgPlan;
  createdAt: string;
}

export interface OrgMemberRecord {
  orgId: string;
  userId: string;
  role: Role;
  createdAt: string;
}

/** An org + the caller's role in it (what a resolver returns for a request). */
export interface OrgMembership {
  org: OrganizationRecord;
  role: Role;
}

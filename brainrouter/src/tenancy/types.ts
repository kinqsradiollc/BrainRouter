/**
 * Tenancy records (ADR-010 P1). The organization tier above the existing user.
 */
import type { Role } from "./rbac.js";

/**
 * Organization plan tiers (single source of truth). Currently descriptive labels
 * — they carry no enforced entitlements/limits yet — but they are owner-settable
 * (see `org:manage`) and surfaced in the dashboard, so the valid set lives here
 * and every create/update path validates against it via {@link isOrgPlan}.
 */
export const ORG_PLANS = ["single", "team", "enterprise"] as const;
export type OrgPlan = (typeof ORG_PLANS)[number];

/** Narrow an unknown value to a valid {@link OrgPlan}. */
export function isOrgPlan(x: unknown): x is OrgPlan {
  return typeof x === "string" && (ORG_PLANS as readonly string[]).includes(x);
}

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

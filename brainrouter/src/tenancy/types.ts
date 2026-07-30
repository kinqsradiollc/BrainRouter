/**
 * Tenancy records (ADR-010 P1). The organization tier above the existing user.
 */
import type { Role } from "./rbac.js";

/**
 * Plan tiers (single source of truth) attached to the tenancy unit — the
 * `organizations` row, which IS "the Team" in the product model (it owns members,
 * memory, providers, projects, and RBAC). The plan controls what that team may use
 * (see {@link ./entitlements}). Owner-settable (`org:manage`) + surfaced in the UI,
 * so every create/update path validates against this set via {@link isOrgPlan}.
 *
 * Tiers (ADR-014): free (solo local-first) · pro (solo, supercharged) · team
 * (shared, invitations) · enterprise (SSO/domain-allowlist/audit) ·
 * self_hosted_enterprise (enterprise features on your own infra).
 */
export const ORG_PLANS = ["free", "pro", "team", "enterprise", "self_hosted_enterprise"] as const;
export type OrgPlan = (typeof ORG_PLANS)[number];

/** Legacy plan labels → current tier (pre-ADR-014 rows used "single"). */
const LEGACY_PLAN_ALIASES: Record<string, OrgPlan> = { single: "free" };

/** Narrow an unknown value to a valid current {@link OrgPlan}. */
export function isOrgPlan(x: unknown): x is OrgPlan {
  return typeof x === "string" && (ORG_PLANS as readonly string[]).includes(x);
}

/** Coerce any stored/legacy value to a valid tier; unknown → the most restrictive. */
export function normalizeOrgPlan(raw: unknown): OrgPlan {
  if (typeof raw === "string") {
    if ((ORG_PLANS as readonly string[]).includes(raw)) return raw as OrgPlan;
    if (raw in LEGACY_PLAN_ALIASES) return LEGACY_PLAN_ALIASES[raw];
  }
  return "free";
}

export interface OrganizationRecord {
  orgId: string;
  name: string;
  slug: string;
  plan: OrgPlan;
  /** Enterprise email-domain allowlist (ADR-014 Phase B). Empty = no restriction. */
  allowedDomains: string[];
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

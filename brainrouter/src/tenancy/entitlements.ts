/**
 * Plan entitlements (ADR-014 Phase A) — the single source of truth that turns the
 * `organizations.plan` label into enforced limits + feature gates.
 *
 * Pure + dependency-free (like {@link ./rbac}) so it unit-tests in isolation and is
 * shared by HTTP middleware, the MCP config gate, and the dashboard. Values are
 * opinionated DEFAULTS that live in code (not per-row) — a self-host operator can
 * fork them without a schema change.
 *
 * `null` = unlimited. Adding a feature is a conscious per-plan decision (explicit
 * matrix, not derived), exactly like the RBAC capability grants.
 */
import type { OrgPlan } from "./types.js";

/** Boolean feature gates a plan may unlock. */
export const PLAN_FEATURES = [
  "sharedMemory", // mark memory/artifacts team-visible (visibility='org')
  "orgPersona", // distil + inject a team consensus persona
  "invites", // invite teammates by email (vs. add existing users only)
  "restrictedProjects", // per-member project access (not everyone sees every project)
  "domainAllowlist", // restrict team membership to specific email domains
  "sso", // team SSO realm
  "githubApp", // team-owned GitHub App / trigger automation
  "auditLogs", // membership/plan/ownership audit trail
  "advancedConnectors", // the full connector catalogue (vs. the free subset)
  "hostedMcp", // hosted MCP endpoint access (vs. localhost-only)
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** Numeric caps a plan imposes. `null` = unlimited. */
export interface PlanLimits {
  /** Max members (seats) in the org. */
  seats: number | null;
  /** Max projects / repos scoped to the org. */
  projects: number | null;
}

export interface PlanEntitlements {
  plan: OrgPlan;
  limits: PlanLimits;
  features: ReadonlySet<PlanFeature>;
}

const feats = (...f: PlanFeature[]): ReadonlySet<PlanFeature> => new Set(f);

/** Every feature (used by the top enterprise tiers). */
const ALL_FEATURES = feats(...PLAN_FEATURES);

/** Plan → entitlements. Mirrors the matrix in ADR-014. */
export const PLAN_ENTITLEMENTS: Record<OrgPlan, PlanEntitlements> = {
  // Solo, local-first — the no-permission-wall personal tier.
  free: {
    plan: "free",
    limits: { seats: 1, projects: 3 },
    features: feats(),
  },
  // Solo, supercharged — still one seat, but more projects + hosted MCP + connectors.
  pro: {
    plan: "pro",
    limits: { seats: 1, projects: 25 },
    features: feats("advancedConnectors", "hostedMcp"),
  },
  // A shared team: roles, org memory/persona, invitations, GitHub automation.
  team: {
    plan: "team",
    limits: { seats: 10, projects: 50 },
    features: feats("sharedMemory", "orgPersona", "invites", "githubApp", "advancedConnectors", "hostedMcp"),
  },
  // Org-wide: everything, unlimited.
  enterprise: {
    plan: "enterprise",
    limits: { seats: null, projects: null },
    features: ALL_FEATURES,
  },
  // Enterprise features, run on the customer's own infrastructure.
  self_hosted_enterprise: {
    plan: "self_hosted_enterprise",
    limits: { seats: null, projects: null },
    features: ALL_FEATURES,
  },
};

/** Entitlements for a plan; falls back to the most restrictive tier for unknown input. */
export function entitlementsFor(plan: OrgPlan | string | null | undefined): PlanEntitlements {
  if (typeof plan === "string" && plan in PLAN_ENTITLEMENTS) {
    return PLAN_ENTITLEMENTS[plan as OrgPlan];
  }
  return PLAN_ENTITLEMENTS.free;
}

/** True when `plan` unlocks `feature`. Unknown plans grant nothing. */
export function planHasFeature(plan: OrgPlan | string | null | undefined, feature: PlanFeature): boolean {
  return entitlementsFor(plan).features.has(feature);
}

/**
 * True when adding rows would stay within the plan's limit. `null` limit = unlimited.
 * `currentCount` is the count BEFORE adding `adding` (default 1).
 */
export function withinLimit(
  plan: OrgPlan | string | null | undefined,
  limitKey: keyof PlanLimits,
  currentCount: number,
  adding = 1,
): boolean {
  const limit = entitlementsFor(plan).limits[limitKey];
  if (limit === null) return true;
  return currentCount + adding <= limit;
}

/** The feature list for a plan (stable array, for surfacing in an API/UI). */
export function featuresFor(plan: OrgPlan | string | null | undefined): PlanFeature[] {
  const ents = entitlementsFor(plan);
  return PLAN_FEATURES.filter((f) => ents.features.has(f));
}

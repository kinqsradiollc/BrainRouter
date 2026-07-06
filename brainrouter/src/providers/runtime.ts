/**
 * Provider runtime resolution (ADR-010 P2). Which org's DB provider configs the
 * backend's SINGLETON services use.
 *
 * For a single-tenant deployment the "system" org is the seeded admin's personal
 * org (deterministic id), overridable with `BRAINROUTER_SYSTEM_ORG_ID` for
 * advanced setups. Per-REQUEST org resolution (true multi-tenant, per-caller
 * providers) is the Provider/LLM-Gateway service (ADR-010 P7); this covers the
 * in-process brain's own extraction/embedding/reranking/judging calls.
 */

/** The org whose DB provider configs back the singleton services. */
export function systemProviderOrgId(): string {
  const explicit = process.env.BRAINROUTER_SYSTEM_ORG_ID?.trim();
  if (explicit) return explicit;
  const adminUser = (process.env.BRAINROUTER_DEFAULT_ADMIN_USER_ID ?? "admin").trim() || "admin";
  return `org_personal_${adminUser}`;
}

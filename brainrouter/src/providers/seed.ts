/**
 * One-time env → DB provider seed (ADR-012 migration). The runtime no longer
 * reads `BRAINROUTER_*` provider vars, so a deployment upgrading from the old
 * `.env` world would suddenly have no LLM/embedding/reranker provider.
 *
 * To make the cutover non-breaking, on boot we migrate any legacy env provider
 * into the system org's DB config ONCE — but only for a kind that has NO DB
 * provider yet (idempotent; never clobbers a dashboard-configured provider).
 * After this runs, the `BRAINROUTER_*` provider vars can be deleted.
 */
import type { ProviderStore } from "./store.js";
import { PROVIDER_KINDS } from "./types.js";
import { resolveFromEnv } from "./resolver.js";

/** Seed the system org's DB providers from legacy env, once. Returns the kinds seeded. */
export async function seedProvidersFromEnv(store: ProviderStore, orgId: string): Promise<string[]> {
  const seeded: string[] = [];
  for (const kind of PROVIDER_KINDS) {
    try {
      const existing = await store.getDefaultResolvedProvider(orgId, kind);
      if (existing?.apiKey) continue; // already DB-configured → never overwrite
      const env = resolveFromEnv(kind);
      if (!env?.apiKey) continue; // nothing in env for this kind
      const rec = await store.createProviderConfig(
        orgId,
        {
          kind,
          label: `${kind} (migrated from .env)`,
          baseUrl: env.endpoint,
          apiKey: env.apiKey,
          model: env.model,
          models: env.models,
          extra: env.extra,
          isDefault: true,
        },
        "env-migration",
      );
      await store.setDefaultProvider(orgId, kind, rec.id);
      seeded.push(kind);
    } catch {
      /* best-effort — a seed failure just means this kind stays unconfigured until an admin sets it */
    }
  }
  if (seeded.length) {
    console.error(
      `[providers] migrated ${seeded.join(", ")} from legacy BRAINROUTER_* env into the DB (org ${orgId}). `
      + `You can now delete those provider env vars — they are no longer read.`,
    );
  }
  return seeded;
}

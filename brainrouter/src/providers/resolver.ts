/**
 * ProviderResolver (ADR-012) — resolve a runtime provider config for (org, kind)
 * from the DATABASE. This is the "new system": providers (LLM / embeddings /
 * reranker / judge) are configured per-org in the DB (dashboard → AI Providers,
 * or POST /api/admin/providers), exactly like desktop/CLI — never `.env`.
 *
 * `resolveFromEnv` is retained ONLY for the one-time upgrade SEED
 * (`seedProvidersFromEnv`): a deployment that still has legacy `BRAINROUTER_*`
 * provider vars gets them migrated into the DB once on boot, then the vars are
 * dead. `resolveProviderConfig` itself no longer reads `process.env`.
 */
import type { ProviderStore } from "./store.js";
import type { ProviderKind, ResolvedProviderConfig } from "./types.js";

const env = (k: string): string => (process.env[k] ?? "").trim();

/** Legacy `.env` provider config for a kind, or null — SEED-ONLY (see above). */
export function resolveFromEnv(kind: ProviderKind): ResolvedProviderConfig | null {
  const base = (
    endpoint: string,
    apiKey: string,
    model: string,
    fallbackEndpoint = "",
  ): ResolvedProviderConfig | null => {
    if (!apiKey) return null;
    return { kind, endpoint: endpoint || fallbackEndpoint, apiKey, model, models: [], extra: {}, source: "env" };
  };
  switch (kind) {
    case "llm":
      return base(env("BRAINROUTER_LLM_ENDPOINT"), env("BRAINROUTER_LLM_API_KEY"), env("BRAINROUTER_LLM_MODEL") || "gpt-4o-mini", "https://api.openai.com/v1/chat/completions");
    case "embedding":
      return base(env("BRAINROUTER_EMBEDDING_ENDPOINT"), env("BRAINROUTER_EMBEDDING_API_KEY") || env("BRAINROUTER_LLM_API_KEY"), env("BRAINROUTER_EMBEDDING_MODEL") || "text-embedding-3-small", "https://api.openai.com/v1/embeddings");
    case "reranker":
      return base(env("BRAINROUTER_RERANKER_ENDPOINT"), env("BRAINROUTER_RERANKER_API_KEY"), env("BRAINROUTER_RERANKER_MODEL") || "rerank-english-v3.0", "https://api.cohere.com/v1/rerank");
    case "judge":
      return base(env("BRAINROUTER_RELEVANCE_JUDGE_ENDPOINT") || env("BRAINROUTER_LLM_ENDPOINT"), env("BRAINROUTER_RELEVANCE_JUDGE_API_KEY") || env("BRAINROUTER_LLM_API_KEY"), env("BRAINROUTER_RELEVANCE_JUDGE_MODEL") || env("BRAINROUTER_LLM_MODEL"), "https://api.openai.com/v1/chat/completions");
    default:
      return null;
  }
}

/**
 * DB-only provider resolution. Returns the org's default provider for the kind,
 * or null when none is configured (the caller then treats that service as
 * unconfigured — recall degrades to keyword-only, cognition is skipped). No env
 * fallback: providers live in the DB now.
 */
export async function resolveProviderConfig(
  store: ProviderStore,
  orgId: string,
  kind: ProviderKind,
): Promise<ResolvedProviderConfig | null> {
  try {
    const db = await store.getDefaultResolvedProvider(orgId, kind);
    // Require an ENDPOINT, not an api key: local providers (LM Studio, Ollama,
    // bge-reranker, …) are keyless. Gating on the key dropped admin-configured
    // keyless embedders/rerankers, silently disabling vector search + reranking.
    if (db && db.endpoint) return db;
  } catch {
    /* DB unavailable / unconfigured → unconfigured */
  }
  return null;
}

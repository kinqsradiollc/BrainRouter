/**
 * ProviderResolver (ADR-010 P2) — resolve a runtime provider config for
 * (org, kind), DB-first with a `.env` fallback during rollout.
 *
 * This is the seam that retires `.env`: `buildServices()`/`modelRunner` call
 * `resolveProviderConfig` instead of reading `process.env` directly. When an org
 * has a DB row (with a key) it wins; otherwise we fall back to the existing
 * `BRAINROUTER_*` env vars so nothing breaks before configs are migrated in.
 */
import type { ProviderStore } from "./store.js";
import type { ProviderKind, ResolvedProviderConfig } from "./types.js";

const env = (k: string): string => (process.env[k] ?? "").trim();

/** The legacy `.env` provider config for a kind, or null when no key is set. */
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
 * DB-first provider resolution with an env fallback. Returns null only when
 * NEITHER a DB row nor an env key exists for the kind (the caller then treats
 * that service as unconfigured — the existing behaviour).
 */
export async function resolveProviderConfig(
  store: ProviderStore,
  orgId: string,
  kind: ProviderKind,
): Promise<ResolvedProviderConfig | null> {
  try {
    const db = await store.getDefaultResolvedProvider(orgId, kind);
    if (db && db.apiKey) return db;
  } catch {
    /* DB unavailable / unconfigured → fall back to env */
  }
  return resolveFromEnv(kind);
}

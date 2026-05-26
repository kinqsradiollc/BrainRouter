/**
 * Provider-agnostic cache-hit accounting (0.3.9 item 10).
 *
 * The three OpenAI-compatible-ish response shapes BrainRouter talks to
 * expose prefix-cache info under different keys:
 *
 *   - **OpenAI / Groq / Fireworks / OpenRouter (OpenAI-compat path)**
 *     `usage.prompt_tokens_details.cached_tokens` (cache hit)
 *     `usage.prompt_tokens_details.cache_creation_tokens` (write,
 *      rare; OpenAI exposes it on the OpenAI-native server but the
 *      `/v1/chat/completions` adapters generally omit)
 *
 *   - **DeepSeek**
 *     `usage.prompt_cache_hit_tokens` (cache hit)
 *     `usage.prompt_cache_miss_tokens` (cache miss)
 *
 * Anthropic native (`/v1/messages`) support was removed in 0.3.9.
 * Claude models routed via OpenRouter / Together still flow through
 * the OpenAI-compat path above — their gateways translate cache
 * fields back into `prompt_tokens_details.cached_tokens` so the
 * first branch picks them up.
 *
 * `extractCacheStats(usage)` returns a normalised
 * `{ cachedTokens, missedTokens, cacheHitRatio }` shape across both
 * supported provider shapes so the rest of the CLI (item 14's
 * `/tokens` panel, the Ink status line, the usage.jsonl roll-up)
 * reads from one place.
 *
 * Reference: `openSrc/DeepSeek-Reasonix/src/telemetry/stats.ts`
 * (`pricingFor`, `costUsd`, `cacheSavingsUsd`).
 */

export interface ProviderUsage {
  // OpenAI-shape canonical fields.
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  // OpenAI prefix-cache nested object (gpt-4o-mini-2024-07-18+, gpt-5,
  // most Groq / Fireworks / OpenRouter passthroughs).
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_creation_tokens?: number;
  };
  // DeepSeek-native flat keys.
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  // Tolerant unknowns: never crash on a new provider field. The
  // Anthropic-native cache_read_input_tokens / cache_creation_input_tokens
  // pair was read here until 0.3.9; users on OpenRouter's Anthropic
  // proxies see the same numbers via `prompt_tokens_details.cached_tokens`.
  [k: string]: unknown;
}

export interface CacheStats {
  /** Tokens served from the provider's prefix cache. */
  cachedTokens: number;
  /** Tokens that paid full input price (not cached). */
  missedTokens: number;
  /** `cachedTokens / (cachedTokens + missedTokens)` in [0, 1]; 0 if both are zero. */
  cacheHitRatio: number;
  /** Which response shape we inferred — useful for tracing and tests. */
  source: 'openai' | 'deepseek' | 'unknown';
}

const EMPTY: CacheStats = { cachedTokens: 0, missedTokens: 0, cacheHitRatio: 0, source: 'unknown' };

/**
 * Read whatever cache fields the response carries and project them to
 * the normalised shape. Order matters: we check DeepSeek first
 * (`prompt_cache_hit_tokens`) then fall through to OpenAI
 * (`prompt_tokens_details.cached_tokens`), which also acts as the
 * catch-all for OpenRouter / Together / Groq / Fireworks passthroughs.
 */
export function extractCacheStats(usage: ProviderUsage | null | undefined): CacheStats {
  if (!usage || typeof usage !== 'object') return { ...EMPTY };

  // DeepSeek native.
  if (
    typeof usage.prompt_cache_hit_tokens === 'number' ||
    typeof usage.prompt_cache_miss_tokens === 'number'
  ) {
    const hit = num(usage.prompt_cache_hit_tokens);
    const miss = num(usage.prompt_cache_miss_tokens);
    const total = hit + miss;
    return {
      cachedTokens: hit,
      missedTokens: miss,
      cacheHitRatio: total > 0 ? hit / total : 0,
      source: 'deepseek',
    };
  }

  // OpenAI-compat (and the catch-all fall-through).
  const cached = num(usage.prompt_tokens_details?.cached_tokens);
  const prompt = num(usage.prompt_tokens);
  // miss = prompt - cached when `prompt_tokens` includes the cached
  // portion (OpenAI convention). DeepSeek's convention is the
  // opposite, but we already branched out above.
  const missed = Math.max(0, prompt - cached);
  const total = cached + missed;
  return {
    cachedTokens: cached,
    missedTokens: missed,
    cacheHitRatio: total > 0 ? cached / total : 0,
    source: prompt > 0 ? 'openai' : 'unknown',
  };
}

/**
 * Combine multiple per-call snapshots into a session-level summary.
 * Used by item 14's `/tokens` panel and the cross-session roll-up
 * (`brainrouter usage --since 7d`).
 */
export function aggregateCacheStats(stats: Iterable<CacheStats>): CacheStats {
  let cached = 0;
  let missed = 0;
  for (const s of stats) {
    cached += s.cachedTokens;
    missed += s.missedTokens;
  }
  const total = cached + missed;
  return {
    cachedTokens: cached,
    missedTokens: missed,
    cacheHitRatio: total > 0 ? cached / total : 0,
    source: 'unknown',
  };
}

/**
 * Compact stringifier for the status line and `/tokens` row. Returns
 * "cache —" when both counters are zero (call hasn't returned usage
 * info — common on local LM Studio / Ollama, or on providers that
 * don't expose cache fields).
 */
export function formatCacheStats(stats: CacheStats): string {
  if (stats.cachedTokens === 0 && stats.missedTokens === 0) return 'cache —';
  const pct = (stats.cacheHitRatio * 100).toFixed(1);
  return `cache ${pct}% (${stats.cachedTokens.toLocaleString()}/${(stats.cachedTokens + stats.missedTokens).toLocaleString()} tok)`;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

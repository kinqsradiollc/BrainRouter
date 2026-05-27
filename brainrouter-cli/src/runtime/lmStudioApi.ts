/**
 * LM Studio native models API (0.3.9 follow-up).
 *
 * LM Studio exposes TWO HTTP endpoints when its server is running:
 *
 *   1. `/v1/models` — OpenAI-compatible, returns only `{ id }` per row.
 *      That's the endpoint our wizard already hits via
 *      `cli/wizard/modelsApi.ts → fetchOpenAiCompatibleModels`.
 *
 *   2. `/api/v1/models` — LM Studio's NATIVE endpoint. Returns a much
 *      richer payload per row:
 *
 *        - `max_context_length` (real per-model context window — we
 *          can stop guessing for models that aren't in our shipped
 *          `config/models.json`)
 *        - `loaded_instances` (whether the model is currently loaded
 *          in memory — empty array = not loaded)
 *        - `capabilities.trained_for_tool_use` (a hard requirement for
 *          the agent loop — a `false` here is the model telling us
 *          it'll botch every tool call)
 *        - `capabilities.reasoning` (which reasoning modes the model
 *          accepts — informs `BRAINROUTER_EFFORT` plumbing)
 *        - `type` ("llm" vs "embedding" — we filter embeddings out
 *          since they're not chat models)
 *
 * This module fetches the native endpoint, caches the result per
 * session, and exposes a synchronous lookup so the rest of the CLI
 * (`contextWindowFor`, `/status`, the model picker) can consult it
 * without adding latency to render paths.
 *
 * When the active endpoint isn't LM Studio (or the call fails), the
 * cache stays empty and callers fall through to the existing JSON
 * config + family-fallback heuristics.
 */

import { traceEvent } from './tracing.js';

export interface LmStudioModelInfo {
  /** Canonical model id LM Studio uses (matches what comes back from
   *  /v1/models too). e.g. `microsoft/phi-4-mini-reasoning`. */
  key: string;
  /** Human-readable name. e.g. `Phi 4 Mini Reasoning`. */
  displayName?: string;
  /** `llm` (chat) or `embedding` — we filter embeddings out of the
   *  enrichment cache because they're not selectable as chat models. */
  type: 'llm' | 'embedding' | string;
  /** Real per-model context window in tokens. May be undefined for very
   *  old / non-standard models. */
  maxContextLength?: number;
  /** True iff `loaded_instances.length > 0` — the model is in RAM and
   *  ready to answer without a cold-load delay. */
  loaded: boolean;
  /** Vendor signal: did the LM Studio packager flag this model as
   *  trained for tool use? `false` means the model probably won't
   *  understand the agent loop. `undefined` means LM Studio didn't
   *  report. */
  trainedForToolUse?: boolean;
  /** Whether the model supports vision input. */
  vision?: boolean;
  /** Reasoning modes the model accepts (`on` / `off`). When the model
   *  has a fixed-on reasoning mode, the agent's `/effort` flag is
   *  effectively a no-op upstream. */
  reasoning?: { allowedOptions: string[]; defaultOption?: string };
  /** Approximate parameter count as reported by LM Studio. */
  paramsString?: string;
  /** Quantisation label, e.g. `4bit`, `Q4_K_M`. */
  quantisation?: string;
  /** File format on disk: `mlx`, `gguf`, etc. */
  format?: string;
}

let cache: Map<string, LmStudioModelInfo> | undefined;
/** Wall-clock when the cache was populated. Stale-check uses this. */
let cachedAt = 0;
/** Distinct rows in the cache (Map.size double-counts because we
 *  register each model under both `key` and `strip(key)`). */
let distinctCount = 0;
const CACHE_TTL_MS = 60_000;

/**
 * Detect whether `endpoint` looks like a local LM Studio install.
 *
 * LM Studio's default is `http://localhost:1234`. We accept both the
 * `localhost` and `127.0.0.1` forms (a few users set the latter
 * explicitly). The check is deliberately conservative — we don't fire
 * the enrichment fetch against an arbitrary OpenAI-compatible endpoint
 * because the `/api/v1/models` path will 404 anywhere except LM Studio.
 */
export function isLmStudioEndpoint(endpoint: string | undefined | null): boolean {
  if (!endpoint || typeof endpoint !== 'string') return false;
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::1234)?(\b|\/)/i.test(endpoint);
}

/**
 * Derive the LM Studio native models URL from the user's configured
 * chat endpoint. The endpoint can come in as:
 *
 *   http://localhost:1234                    → http://localhost:1234/api/v1/models
 *   http://localhost:1234/v1                 → http://localhost:1234/api/v1/models
 *   http://localhost:1234/v1/chat/completions → http://localhost:1234/api/v1/models
 *
 * LM Studio's native `/api/v1` namespace is SIBLING to its OpenAI-compat
 * `/v1` namespace, not nested under it — so we strip BOTH `/v1` and any
 * trailing `/chat/completions` before re-attaching `/api/v1/models`.
 */
export function deriveLmStudioModelsUrl(endpoint: string): string {
  // Drop any trailing slash, then `/chat/completions`, then a trailing `/v1`.
  let base = endpoint.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) base = base.slice(0, -'/chat/completions'.length);
  if (base.endsWith('/v1')) base = base.slice(0, -'/v1'.length);
  return `${base}/api/v1/models`;
}

/**
 * Fetch and parse LM Studio's native models payload. Caller is
 * responsible for filtering by `type === 'llm'` if they only want
 * chat models (the embedding rows are needed for `/embeddings` UX).
 *
 * Returns `null` when the call fails (network error, non-LM-Studio
 * endpoint, server not running) so callers can fall through cleanly.
 */
export async function fetchLmStudioModels(endpoint: string): Promise<LmStudioModelInfo[] | null> {
  if (!isLmStudioEndpoint(endpoint)) return null;
  const url = deriveLmStudioModelsUrl(endpoint);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      traceEvent('lmstudio.models.fetch_fail', { url, status: res.status });
      return null;
    }
    const data = (await res.json()) as { models?: unknown[] };
    if (!data || !Array.isArray(data.models)) return null;
    const parsed: LmStudioModelInfo[] = [];
    for (const row of data.models) {
      const info = parseLmStudioModel(row);
      if (info) parsed.push(info);
    }
    traceEvent('lmstudio.models.fetch_ok', { url, count: parsed.length });
    return parsed;
  } catch (err) {
    // AbortError, ENOTFOUND, ECONNREFUSED — all expected when LM
    // Studio isn't actually running. Stay quiet.
    traceEvent('lmstudio.models.fetch_err', { url, error: (err as Error)?.message ?? String(err) });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Internal parser — tolerates shape drift in LM Studio's payload
 * (their API has moved a couple of fields between versions). Anything
 * unrecognised becomes `undefined` rather than crashing the parse.
 */
function parseLmStudioModel(raw: unknown): LmStudioModelInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || r.key.length === 0) return null;
  const type = typeof r.type === 'string' ? r.type : 'unknown';
  const max = typeof r.max_context_length === 'number' ? r.max_context_length : undefined;
  const loadedInstances = Array.isArray(r.loaded_instances) ? r.loaded_instances : [];
  const caps = (r.capabilities && typeof r.capabilities === 'object') ? r.capabilities as Record<string, unknown> : undefined;
  const reasoning = caps?.reasoning && typeof caps.reasoning === 'object'
    ? caps.reasoning as Record<string, unknown>
    : undefined;
  const quant = (r.quantization && typeof r.quantization === 'object')
    ? r.quantization as Record<string, unknown>
    : undefined;
  return {
    key: r.key,
    displayName: typeof r.display_name === 'string' ? r.display_name : undefined,
    type,
    maxContextLength: max,
    loaded: loadedInstances.length > 0,
    trainedForToolUse: typeof caps?.trained_for_tool_use === 'boolean'
      ? caps.trained_for_tool_use as boolean
      : undefined,
    vision: typeof caps?.vision === 'boolean' ? caps.vision as boolean : undefined,
    reasoning: reasoning && Array.isArray(reasoning.allowed_options)
      ? {
          allowedOptions: (reasoning.allowed_options as unknown[]).filter((o): o is string => typeof o === 'string'),
          defaultOption: typeof reasoning.default === 'string' ? reasoning.default : undefined,
        }
      : undefined,
    paramsString: typeof r.params_string === 'string' ? r.params_string : undefined,
    quantisation: typeof quant?.name === 'string' ? quant.name as string : undefined,
    format: typeof r.format === 'string' ? r.format : undefined,
  };
}

/**
 * Populate the in-memory enrichment cache. Called once at session
 * boot when the active endpoint is LM Studio; can also be called
 * manually via `/model refresh` (future work). The cache is keyed by
 * the canonical LM Studio `key`, lowercased.
 */
export async function refreshLmStudioCache(endpoint: string | undefined | null): Promise<number> {
  if (!isLmStudioEndpoint(endpoint)) {
    cache = undefined;
    cachedAt = 0;
    distinctCount = 0;
    return 0;
  }
  const fetched = await fetchLmStudioModels(endpoint!);
  if (!fetched) {
    // Leave any prior cache in place — better stale than empty.
    return distinctCount;
  }
  // Store under BOTH the fully-qualified key (`microsoft/phi-4-mini-reasoning`)
  // AND the vendor-prefix-stripped form (`phi-4-mini-reasoning`) so the
  // `contextWindowFor` lookup hits regardless of how the model id is
  // shaped when it crosses module boundaries. Counted entries are
  // distinct rows — multi-form storage doesn't inflate the reported size.
  const fresh = new Map<string, LmStudioModelInfo>();
  for (const m of fetched) {
    const lower = m.key.toLowerCase();
    fresh.set(lower, m);
    if (lower.includes('/')) {
      const stripped = lower.slice(lower.lastIndexOf('/') + 1);
      // Don't clobber an earlier model that happens to have the same
      // tail; first writer wins.
      if (!fresh.has(stripped)) fresh.set(stripped, m);
    }
  }
  cache = fresh;
  cachedAt = Date.now();
  distinctCount = fetched.length;
  // Report distinct-model count (not Map size, which can be 2× larger).
  return distinctCount;
}

/**
 * Synchronous lookup against the populated cache. Returns `undefined`
 * when the cache is empty (not LM Studio, or never populated) OR when
 * the model isn't in the cache.
 *
 * The matching is case-insensitive and strips an optional vendor
 * prefix the way `pricingFor` / `contextWindowFor` do, so
 * `openai/gpt-5` and `gpt-5` resolve identically.
 */
export function lookupLmStudioModel(modelId: string | undefined | null): LmStudioModelInfo | undefined {
  if (!cache || cache.size === 0 || !modelId) return undefined;
  const raw = modelId.toLowerCase();
  const stripped = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  return cache.get(raw) ?? cache.get(stripped);
}

/** Snapshot of the cache for `/status` rendering and tests. De-duplicated
 *  because we store each model under both its fully-qualified key and
 *  its vendor-prefix-stripped form. */
export function lmStudioCacheSnapshot(): { entries: LmStudioModelInfo[]; cachedAt: number } {
  if (!cache) return { entries: [], cachedAt };
  const byKey = new Map<string, LmStudioModelInfo>();
  for (const m of cache.values()) {
    byKey.set(m.key, m);
  }
  return {
    entries: [...byKey.values()],
    cachedAt,
  };
}

/** Cache age in ms; Infinity when never populated. */
export function lmStudioCacheAgeMs(): number {
  if (!cache || cachedAt === 0) return Infinity;
  return Date.now() - cachedAt;
}

/** Indicates whether the cache is stale enough that a refresh is overdue. */
export function lmStudioCacheStale(): boolean {
  return lmStudioCacheAgeMs() > CACHE_TTL_MS;
}

/** Test hook — drop the cache so the next refresh re-fetches. */
export function _resetLmStudioCache(): void {
  cache = undefined;
  cachedAt = 0;
  distinctCount = 0;
}

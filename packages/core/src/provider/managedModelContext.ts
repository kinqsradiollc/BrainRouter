/**
 * ADR-045 M4 — the client honors the context window a BrainRouter gateway
 * ADVERTISES.
 *
 * M3 made an org, acting as a provider, cap the context window by publishing a
 * `context_window` on each row of the gateway's `/v1/models`. This is the other
 * half: when a client fetches that model list, it records the advertised window
 * here, and `contextWindowFor` CLAMPS a model's window to it — so the org ceiling
 * actually tightens what a member's client will use.
 *
 * A plain OpenAI-compatible `/models` omits `context_window`, so nothing is
 * recorded for a direct provider and the clamp is inert; only a gateway with a
 * cap set populates this. Session-scoped in-memory cache, mirroring the LM Studio
 * enrichment cache — repopulated whenever the model list is refreshed.
 */

const cache = new Map<string, number>();

export interface AdvertisedModelContext {
  id: string;
  /** The advertised context window in tokens (the OpenAI `context_window` field). */
  contextWindow: number;
}

/**
 * Extract the advertised `context_window` from a raw `/v1/models` `data` array.
 * Rows without a positive numeric `context_window` (every non-gateway endpoint)
 * are skipped. Pure — no caching side effect, so it is trivially testable.
 */
export function extractAdvertisedContext(rows: unknown): AdvertisedModelContext[] {
  if (!Array.isArray(rows)) return [];
  const out: AdvertisedModelContext[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as { id?: unknown; context_window?: unknown };
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    const win = typeof r.context_window === 'number' ? r.context_window : Number.NaN;
    if (id && Number.isFinite(win) && win > 0) out.push({ id, contextWindow: Math.floor(win) });
  }
  return out;
}

/**
 * Record the advertised windows for one endpoint's model list. Idempotent per id
 * (the latest refresh wins). Model ids are lowercased to match `contextWindowFor`.
 */
export function setManagedModelContext(entries: readonly AdvertisedModelContext[]): void {
  for (const entry of entries) {
    if (entry.contextWindow > 0) cache.set(entry.id.toLowerCase(), Math.floor(entry.contextWindow));
  }
}

/** The advertised context window for a model id (exact or vendor-prefix-stripped), or undefined. */
export function lookupManagedModelContext(modelId: string | undefined | null): number | undefined {
  if (!modelId || typeof modelId !== 'string') return undefined;
  const raw = modelId.toLowerCase();
  if (cache.has(raw)) return cache.get(raw);
  const stripped = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  return cache.get(stripped);
}

/** Test hook. */
export function clearManagedModelContextForTests(): void {
  cache.clear();
}

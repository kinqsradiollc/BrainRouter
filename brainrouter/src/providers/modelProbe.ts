/**
 * Model discovery + provider-id derivation (parity with the desktop add-provider
 * flow) — REUSES @kinqs/brainrouter-core rather than re-implementing:
 *   - `findProviderByEndpoint` derives the provider id from the base URL, so the
 *     dashboard no longer needs a manual "Provider id" field;
 *   - LM Studio gets native `/api/v1/models` enrichment;
 *   - the generic path fetches the OpenAI-compatible `GET /models` and tags each
 *     model's reasoning capability via `inferModelReasoningCapabilities`.
 */
import { resolveModelsUrl } from "./wireFormat.js";

// Loaded lazily + defensively — core's provider barrel is Node-safe and already a
// backend dependency, but we tolerate any export drift without crashing a probe.
type CoreProvider = {
  findProviderByEndpoint?: (endpoint: string) => { id?: string } | undefined;
  isLmStudioEndpoint?: (endpoint: string) => boolean;
  fetchLmStudioModels?: (endpoint: string) => Promise<Array<{ id: string; reasoning?: boolean }> | null>;
  inferModelReasoningCapabilities?: (raw: unknown) => { supportsReasoning?: boolean } | undefined;
  LOCAL_PLACEHOLDER_KEY?: string;
};

async function core(): Promise<CoreProvider> {
  try {
    return (await import("@kinqs/brainrouter-core/provider")) as unknown as CoreProvider;
  } catch {
    return {};
  }
}

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Derive the provider id from the endpoint (via core's catalog) or the label. */
export async function deriveProviderId(baseUrl?: string, label?: string): Promise<string> {
  const c = await core();
  const byEndpoint = baseUrl && c.findProviderByEndpoint ? c.findProviderByEndpoint(baseUrl)?.id : undefined;
  if (byEndpoint) return byEndpoint;
  return slug(label ?? "") || "openai-compatible";
}

export interface ProbedModel {
  id: string;
  reasoning?: boolean;
}

/**
 * Fetch the models an endpoint exposes. For `kind: 'llm'` (default) LM Studio's
 * native /api/v1/models enrichment is used (context windows, reasoning, loaded) —
 * but that endpoint FILTERS OUT embedding-type models, so for embedding/reranker
 * we go straight to the plain OpenAI-compatible GET /v1/models (which returns
 * every model, incl. `text-embedding-*`).
 */
export async function probeModels(baseUrl: string, apiKey: string, kind: string = "llm", timeoutMs = 8000): Promise<ProbedModel[]> {
  const c = await core();
  const chat = kind === "llm" || kind === "judge" || !kind;

  // LM Studio native enrichment — chat only (it drops embedding-type models).
  if (chat && c.isLmStudioEndpoint?.(baseUrl) && c.fetchLmStudioModels) {
    const lm = await c.fetchLmStudioModels(baseUrl).catch(() => null);
    if (lm && lm.length) {
      return lm.map((m) => ({ id: m.id, reasoning: !!m.reasoning })).filter((m) => m.id);
    }
  }

  const url = resolveModelsUrl(baseUrl);
  if (!url) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = apiKey || c.LOCAL_PLACEHOLDER_KEY || "";
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GET ${url} → ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    const data = (await res.json()) as any;
    const list: unknown[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const seen = new Set<string>();
    const out: ProbedModel[] = [];
    for (const m of list) {
      const id = typeof m === "string" ? m : (m as any)?.id ?? (m as any)?.name;
      if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;
      seen.add(id);
      let reasoning: boolean | undefined;
      try { reasoning = c.inferModelReasoningCapabilities?.(m)?.supportsReasoning; } catch { /* best-effort */ }
      out.push({ id, reasoning });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  } finally {
    clearTimeout(timer);
  }
}

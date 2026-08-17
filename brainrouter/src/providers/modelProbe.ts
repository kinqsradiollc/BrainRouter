/**
 * Model discovery + provider-id derivation (parity with the desktop add-provider
 * flow) — REUSES @kinqs/brainrouter-core rather than re-implementing:
 *   - `findProviderByEndpoint` derives the provider id from the base URL, so the
 *     dashboard no longer needs a manual "Provider id" field;
 *   - LM Studio gets native `/api/v1/models` enrichment;
 *   - the generic path fetches the OpenAI-compatible `GET /models` and tags each
 *     model's reasoning capability via `inferModelReasoningCapabilities`.
 */
import { resolveModelsUrl, resolveEmbeddingsUrl } from "./wireFormat.js";
import { fetchUpstreamWithPolicy } from "../services/gateway/upstreamPolicy.js";
import type { UpstreamTargetPolicy } from "@kinqs/brainrouter-core/provider";

// Loaded lazily + defensively — core's provider barrel is Node-safe and already a
// backend dependency, but we tolerate any export drift without crashing a probe.
type CoreProvider = {
  findProviderByEndpoint?: (endpoint: string) => { id?: string } | undefined;
  isLmStudioEndpoint?: (endpoint: string) => boolean;
  fetchLmStudioModels?: (endpoint: string, fetchImpl?: (url: string, init: RequestInit) => Promise<Response>) => Promise<Array<{ id: string; reasoning?: boolean }> | null>;
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
/**
 * Probe a provider's model list.
 *
 * `policy` is the SSRF boundary, not an optimisation. `baseUrl` arrives raw from
 * an admin request body, and every request built from it used bare `fetch` — so
 * `http://169.254.169.254/...` or a docker-internal address was reachable, and
 * the GET variant returned the response body to the caller. Hosted mode is
 * fail-closed (loopback and RFC1918 are refused); a self-hosted deployment that
 * legitimately runs Ollama or LM Studio opts in with an exact-origin allowlist.
 * Omitted means hosted, because the safe default must be the one you get by
 * forgetting.
 */
export async function probeModels(baseUrl: string, apiKey: string, kind: string = "llm", timeoutMs = 8000, policy: UpstreamTargetPolicy = {}): Promise<ProbedModel[]> {
  const c = await core();
  const chat = kind === "llm" || !kind;

  // LM Studio native enrichment — chat only (it drops embedding-type models).
  if (chat && c.isLmStudioEndpoint?.(baseUrl) && c.fetchLmStudioModels) {
    // ADR-039 — the LM Studio native enrichment is the "fourth path": route it
    // through the same DNS-pinned upstream policy as the GET /models, embeddings,
    // and rerank probes so a BYOK baseUrl cannot SSRF loopback/RFC1918/metadata.
    const lm = await c
      .fetchLmStudioModels(baseUrl, (url, init) => fetchUpstreamWithPolicy(url, init, policy))
      .catch(() => null);
    if (lm && lm.length) {
      return lm.map((m) => ({ id: m.id, reasoning: !!m.reasoning })).filter((m) => m.id);
    }
  }

  // Rerankers are a POST /rerank surface: many (Cohere-style, TEI, dedicated
  // vLLM rerank servers) don't serve GET /models at all, and a base saved as
  // ".../v1/rerank" must not be probed as GET ".../v1/rerank/models". Strip the
  // action suffix for the listing attempt, and on failure verify the endpoint
  // with a minimal POST /rerank instead of surfacing a misleading GET error.
  if (kind === "reranker") {
    const rerankBase = baseUrl.replace(/\/+$/, "").replace(/\/rerank$/, "");
    try {
      return await probeModelsViaGet(rerankBase, apiKey, timeoutMs, c, policy);
    } catch (listError) {
      const alive = await probeRerankEndpoint(rerankBase, apiKey, timeoutMs, c, policy);
      if (alive) return []; // reachable rerank endpoint, no listing — type the model manually
      throw listError;
    }
  }

  return probeModelsViaGet(baseUrl, apiKey, timeoutMs, c, policy);
}

/**
 * POST a minimal request to `{base}/rerank`. A 2xx — or a 4xx JSON validation
 * error (missing/unknown model) — proves a live rerank surface; 404/405/network
 * failures do not.
 */
async function probeRerankEndpoint(base: string, apiKey: string, timeoutMs: number, c: Awaited<ReturnType<typeof core>>, policy: UpstreamTargetPolicy): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = apiKey || c.LOCAL_PLACEHOLDER_KEY || "";
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetchUpstreamWithPolicy(`${base}/rerank`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "connectivity probe", documents: ["a", "b"], top_n: 1 }),
      signal: controller.signal,
    }, policy);
    if (res.ok) return true;
    if (res.status === 404 || res.status === 405) return false;
    // 400/401/422 etc.: the rerank route exists and parsed the request shape.
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeModelsViaGet(baseUrl: string, apiKey: string, timeoutMs: number, c: Awaited<ReturnType<typeof core>>, policy: UpstreamTargetPolicy): Promise<ProbedModel[]> {
  const url = resolveModelsUrl(baseUrl);
  if (!url) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = apiKey || c.LOCAL_PLACEHOLDER_KEY || "";
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetchUpstreamWithPolicy(url, { headers, signal: controller.signal }, policy);
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

/**
 * Test-embed a tiny string to discover the model's output DIMENSION. Used by the
 * guard that warns before swapping to a different-dimension embedder (which would
 * force the whole `cognitive_vec` table to be rebuilt + re-embedded).
 * Returns the dimension, or null if the probe fails.
 */
export async function probeEmbeddingDim(baseUrl: string, apiKey: string, model: string, timeoutMs = 8000, policy: UpstreamTargetPolicy = {}): Promise<number | null> {
  const url = resolveEmbeddingsUrl(baseUrl);
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = apiKey || (await core()).LOCAL_PLACEHOLDER_KEY || "";
    if (key) headers.Authorization = `Bearer ${key}`;
    const res = await fetchUpstreamWithPolicy(url, { method: "POST", headers, body: JSON.stringify({ input: "dimension probe", model }), signal: controller.signal }, policy);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const vec = data?.data?.[0]?.embedding;
    return Array.isArray(vec) && vec.length > 0 ? vec.length : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

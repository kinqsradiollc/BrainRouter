import type { ProviderEntry } from './providers.js';

/**
 * Fetch the live model list from an OpenAI-compatible `/v1/models`
 * endpoint and return them as a sorted, deduped string array.
 *
 * Every OpenAI-compatible server we ship a provider entry for honours
 * `GET <endpoint>/models` (OpenAI, DeepSeek, OpenRouter, LM Studio,
 * Ollama, vLLM, gateway proxies like LiteLLM). The response shape is
 * `{ object: 'list', data: [{ id: string, owned_by?: string, ... }] }`.
 *
 * We derive the `/models` URL from the provider's chat endpoint by
 * stripping the trailing `/chat/completions` path segment. That works
 * for every endpoint shape we care about:
 *
 *   https://api.openai.com/v1/chat/completions    → /v1/models
 *   http://localhost:1234/v1/chat/completions     → /v1/models
 *   https://openrouter.ai/api/v1/chat/completions → /api/v1/models
 *
 * 5-second timeout — if the call hangs or fails, the wizard falls
 * back to the provider's curated static catalog so users on a slow
 * link / behind a captive portal aren't blocked.
 */
export async function fetchOpenAiCompatibleModels(
  provider: ProviderEntry,
  apiKey: string,
  endpointOverride?: string,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const chatEndpoint = endpointOverride ?? provider.endpoint;
  const modelsUrl = deriveModelsUrl(chatEndpoint);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Cloud providers always want a Bearer header. Local endpoints (LM
  // Studio, Ollama) accept anything OR nothing, but sending the key
  // through doesn't hurt — they ignore it.
  if (apiKey.trim().length > 0) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  } else if (provider.local) {
    // Some local servers reject requests with NO Authorization header
    // even though they don't validate the value. A literal "local"
    // bearer is the convention for LM Studio / Ollama config snippets.
    headers['Authorization'] = 'Bearer local';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(modelsUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${res.statusText} — ${text.slice(0, 200)}` };
    }
    const data = await res.json() as any;
    const list = Array.isArray(data?.data) ? data.data : [];
    const ids = list
      .map((m: any) => (typeof m?.id === 'string' ? m.id : null))
      .filter((s: string | null): s is string => !!s);
    if (ids.length === 0) {
      return { ok: false, error: 'endpoint returned an empty model list' };
    }
    return { ok: true, models: dedupeAndSort(ids) };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { ok: false, error: 'timed out after 5s' };
    }
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timeout);
  }
}

export function deriveModelsUrl(chatEndpoint: string): string {
  // Replace a trailing `/chat/completions` (with optional trailing
  // slash) with `/models`. If the endpoint doesn't end in
  // `/chat/completions` (already a base URL, custom path), append
  // `/models` directly.
  const trimmed = chatEndpoint.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed.slice(0, -'/chat/completions'.length) + '/models';
  }
  return trimmed + '/models';
}

function dedupeAndSort(ids: string[]): string[] {
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

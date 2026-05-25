import { runPicker, type PickerRow } from '../ink/runPicker.js';
import type { Theme } from '../theme.js';
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

// ---------------------------------------------------------------------------
// Reusable model picker
// ---------------------------------------------------------------------------

/**
 * Open the model picker — live `/v1/models` fetch with the provider's
 * static catalog as the offline fallback. Returns the selected model id,
 * or `undefined` when the user cancels.
 *
 * Used by both the onboarding wizard's Model step
 * (`cli/wizard/runner.ts → runModelStep`) and the in-REPL `/model`
 * quick-swap command (`cli/commands/ui.ts → /model`). Keeping a single
 * implementation means a future enrichment (recently-used badge,
 * cost-per-token hint, model-size group headers) lights up everywhere
 * at once.
 *
 * `currentModel` (when supplied) defaults the picker cursor onto the
 * currently active row — important for `/model` where the user almost
 * always wants to confirm what's currently selected before changing.
 */
export interface SelectModelOptions {
  theme: Theme;
  provider: ProviderEntry;
  apiKey: string;
  /** Override the provider's default chat endpoint (custom-endpoint flow). */
  endpointOverride?: string;
  /** Active model id — cursor opens on this row when present. */
  currentModel?: string;
  /** Picker title (default: "Model"). */
  title?: string;
  /** Optional badge rendered next to the title. */
  badge?: string;
  /** Erase the picker frame after a selection (true for wizard, false for in-REPL). */
  eraseOnClose?: boolean;
}

export interface SelectModelResult {
  model: string;
  /** Where the picker got its list from — surfaces in the success message. */
  source: 'live' | 'static' | 'fallback';
  /** Number of models the live call returned (0 when source !== 'live'). */
  liveCount: number;
  /** Live-call error message when source !== 'live' (omitted on live success). */
  liveError?: string;
}

export async function selectModel(opts: SelectModelOptions): Promise<SelectModelResult | undefined> {
  const { provider, apiKey, endpointOverride, currentModel, theme } = opts;
  let modelsList: string[] = provider.models;
  let source: SelectModelResult['source'] = 'static';
  let liveCount = 0;
  let liveError: string | undefined;
  let subtitleHint = `Pick the chat model for ${provider.label}.`;

  // Live fetch is gated on either having a key (cloud) or running local.
  // Skipping the fetch entirely when neither is true avoids a guaranteed
  // 401 / network error on the loading frame.
  if (apiKey.trim().length > 0 || provider.local) {
    const fetched = await fetchOpenAiCompatibleModels(provider, apiKey, endpointOverride);
    if (fetched.ok) {
      const live = fetched.models;
      // Default model floats to the top so "(default)" stays in the
      // natural-first position the user expects. Then the currently-
      // active model floats next (cursor lands here below).
      const reordered = floatToTop(live, [provider.defaultModel]);
      modelsList = reordered;
      source = 'live';
      liveCount = live.length;
      subtitleHint = `Pick a model — ${live.length} returned by ${provider.label}'s /v1/models endpoint. Use "Other" to type any name.`;
    } else {
      source = 'fallback';
      liveError = fetched.error;
      subtitleHint = `Pick a model. (Live list unavailable — ${fetched.error}. Showing curated short-list.) Use "Other" to type any name.`;
    }
  }

  const finalList = modelsList.length > 0 ? modelsList : [provider.defaultModel];
  const rows: PickerRow[] = finalList.map((m) => ({
    id: m,
    label: m,
    value:
      m === currentModel ? 'current' :
      m === provider.defaultModel ? 'default' : '',
  }));

  // Cursor priority: currently-active model > provider default > top.
  let initialCursor = 0;
  if (currentModel) {
    const idx = finalList.indexOf(currentModel);
    if (idx >= 0) initialCursor = idx;
  }
  if (initialCursor === 0 && !currentModel) {
    const idx = finalList.indexOf(provider.defaultModel);
    if (idx >= 0) initialCursor = idx;
  }

  const result = await runPicker({
    theme,
    title: opts.title ?? 'Model',
    subtitle: subtitleHint,
    badge: opts.badge,
    rows,
    initialCursor,
    allowOther: true,
    otherLabel: 'Other model',
    otherDescription: 'Type any model name supported by this endpoint',
    eraseOnClose: opts.eraseOnClose ?? false,
  });
  if (result.kind === 'cancelled') return undefined;
  const model = (result.kind === 'other' ? result.text.trim() : result.id) || provider.defaultModel;
  return { model, source, liveCount, liveError };
}

function floatToTop(list: string[], priority: string[]): string[] {
  const seen = new Set<string>();
  const front: string[] = [];
  for (const p of priority) {
    if (list.includes(p) && !seen.has(p)) {
      front.push(p);
      seen.add(p);
    }
  }
  for (const m of list) {
    if (!seen.has(m)) {
      front.push(m);
      seen.add(m);
    }
  }
  return front;
}

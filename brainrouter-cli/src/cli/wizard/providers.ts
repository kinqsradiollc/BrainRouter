/**
 * 0.3.7 wizard — curated provider catalogue.
 *
 * As of 0.3.9 the catalog data lives in `brainrouter-cli/config/providers.json`
 * (entries with `pickerVisible: true`). This module is a thin TypeScript wrapper
 * over `configLoader` so existing imports (`PROVIDER_CATALOG`, `findProvider`,
 * `detectProviderFromEnv`, `validateApiKey`, `maskApiKey`) keep working.
 *
 * Adding a provider: edit `config/providers.json` (set `pickerVisible: true` to
 * make it appear here). The `/config` provider picker reads the same array
 * through this module's `PROVIDER_CATALOG` export.
 *
 */

import { loadApiKeyPrefixesConfig, loadProvidersConfig } from '../../runtime/configLoader.js';

export interface ProviderEntry {
  /** Stable id used in config.json + tests. */
  id: string;
  /** Human-readable picker label. */
  label: string;
  /** One-line picker hint shown after the em-dash. */
  hint: string;
  /** OpenAI-compatible /v1/chat/completions endpoint. */
  endpoint: string;
  /** Env var the wizard checks to pre-detect a usable key. */
  envKey: string;
  /** True when the provider runs locally and a blank API key is fine. */
  local: boolean;
  /** Curated short-list of model names for the picker (plus "Other"). */
  models: string[];
  /** Default model selected by the wizard when none was previously set. */
  defaultModel: string;
}

/**
 * The provider catalog now lives in `brainrouter-cli/config/providers.json`.
 * This module reads the JSON file via `configLoader` and filters to entries
 * with `pickerVisible: true` so the picker stays tight (deepseek lives in
 * the JSON for tier-ladder purposes but is hidden from the picker — point
 * the OpenAI base URL at api.deepseek.com/v1 instead).
 *
 * NOTE: endpoint values are BASE URLs (ending in `/v1` or `/api/v1`), NOT
 * full `/chat/completions` URLs. The agent's `callOpenAI()` appends the
 * suffix itself. Older revisions stored the full URL and produced
 * `/chat/completions/chat/completions` 404s.
 */
function buildProviderCatalogFromConfig(): ProviderEntry[] {
  const cfg = loadProvidersConfig();
  const out: ProviderEntry[] = [];
  for (const [id, entry] of Object.entries(cfg.providers)) {
    if (entry.pickerVisible !== true) continue;
    // Each picker-visible entry MUST carry the picker fields. Skip silently
    // when a config edit ships a half-populated row so the rest of the
    // catalog stays usable.
    if (!entry.label || !entry.hint || !entry.endpoint || !entry.envKey ||
        !entry.models || entry.models.length === 0 || !entry.defaultModel) {
      continue;
    }
    out.push({
      id,
      label: entry.label,
      hint: entry.hint,
      endpoint: entry.endpoint,
      envKey: entry.envKey,
      local: entry.local === true,
      models: entry.models,
      defaultModel: entry.defaultModel,
    });
  }
  return out;
}

export const PROVIDER_CATALOG: ProviderEntry[] = buildProviderCatalogFromConfig();

/**
 * Look up a provider entry by stable id. Returns undefined when the id
 * isn't in the catalog — caller decides whether that's an error
 * (`/config` reject) or a fallback (custom-endpoint flow).
 */
export function findProvider(id: string): ProviderEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

/**
 * Pre-detect which providers already have a usable key in the shell
 * environment. Used by the wizard's Provider step to pre-select the
 * row most likely to "just work". Returns the FIRST hit so first-time
 * users with multiple keys set don't get a random pick — order in
 * PROVIDER_CATALOG is the precedence.
 */
export function detectProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProviderEntry | undefined {
  for (const provider of PROVIDER_CATALOG) {
    const value = env[provider.envKey];
    if (value && value.trim().length > 0) return provider;
  }
  return undefined;
}

/**
 * 0.3.7 wizard API-key validation tier.
 *
 * `Accept` — the key is plausibly fine; persist it as-is.
 *   - `warning` carries a non-blocking hint (e.g. "unusual prefix —
 *     check your provider's dashboard if calls fail").
 * `Reject` — the input is structurally invalid; refuse to persist and
 *   ask the user to re-enter.
 *
 * Pattern lifted from
 * (`enum ApiKeyValidation { Accept{warning}, Reject(String) }`). The
 * idea is to warn-not-block on unrecognised key shapes because every
 * vendor invents new prefixes (`sk-`, `sk-or-v1-`, `dsk-`, `pk-`, …)
 * and rejecting on shape alone locks users out of legitimate setups.
 */
export type ApiKeyValidation =
  | { kind: 'accept'; warning?: string }
  | { kind: 'reject'; reason: string };

/**
 * Known API-key prefixes are now loaded from
 * `brainrouter-cli/config/api-key-prefixes.json`. An unfamiliar prefix
 * yields a one-shot wizard warning ("did you paste a tag?") but still
 * persists the key.
 */
function loadKnownPrefixes(): string[] {
  const cfg = loadApiKeyPrefixesConfig();
  return cfg.known.map((e) => e.prefix);
}

export function validateApiKey(
  raw: string,
  provider: ProviderEntry,
): ApiKeyValidation {
  const key = raw.trim();
  // Local endpoints (LM Studio, Ollama, custom) accept blank keys —
  // they often want a literal "lm-studio" / "ollama" / "local" string
  // because the server checks for non-empty Bearer presence.
  if (provider.local) {
    return { kind: 'accept' };
  }
  if (key.length === 0) {
    return { kind: 'reject', reason: 'API key is required for cloud providers.' };
  }
  // Suspiciously short for a real provider key — almost always a paste
  // error (the user copied a tag, not the full secret).
  if (key.length < 16) {
    return { kind: 'reject', reason: `Key is ${key.length} characters — that looks like a paste error (real provider keys are 32+ chars).` };
  }
  const knownPrefixes = loadKnownPrefixes();
  const hasKnownPrefix = knownPrefixes.some((p) => key.startsWith(p));
  if (!hasKnownPrefix) {
    return {
      kind: 'accept',
      warning: `Unfamiliar key prefix (expected one of ${knownPrefixes.slice(0, 3).join(', ')}…). Saved as-is — if calls fail, double-check the value from your provider's dashboard.`,
    };
  }
  return { kind: 'accept' };
}

/**
 * Last-four masking for API keys. Visible everywhere the key is
 * displayed (Done step summary, `/config` panel, `/where` workspace
 * block). Always keeps a fixed-width tail so two keys with different
 * lengths align in the panel.
 */
export function maskApiKey(raw: string): string {
  const key = raw.trim();
  if (key.length === 0) return '(none)';
  if (key.length <= 4) return '·'.repeat(key.length);
  return '·'.repeat(8) + key.slice(-4);
}

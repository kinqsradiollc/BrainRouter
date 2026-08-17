/**
 * Provider catalog API — the list the `/config` + Desktop pickers show, plus
 * env auto-detection and key validation/masking.
 *
 * Built-in providers are now defined in code (one module per provider under
 * `./providers/`, aggregated by `./providers/index.ts`). A user can still ADD
 * providers via `~/.config/brainrouter/providers.json` (`pickerVisible: true`);
 * those are appended after the built-ins. Built-in ids win over JSON of the same
 * id — the code modules are authoritative.
 *
 * NOTE: endpoint values are BASE URLs (ending in `/v1` or `/api/v1`), NOT full
 * `/chat/completions` URLs — `callOpenAI()` appends the suffix itself.
 */

import { loadApiKeyPrefixesConfig, loadProvidersConfig } from '../config/configLoader.js';
import { BUILTIN_PROVIDERS, PROVIDER_REGISTRY } from './providers/index.js';
import { extensionProviders } from '../extension/registry.js';

export interface ProviderEntry {
  /** Stable id used in config.json + tests. */
  id: string;
  /** Human-readable picker label. */
  label: string;
  /** One-line picker hint shown after the em-dash. */
  hint: string;
  /** OpenAI-compatible base URL (may be empty for the generic compatible/custom provider). */
  endpoint: string;
  /** Env var the wizard checks to pre-detect a usable key. */
  envKey: string;
  /** True when the provider runs locally and a blank API key is fine. */
  local: boolean;
  /** Optional user-supplied/static fallback list. Built-ins keep this empty; live `/models` wins. */
  models: string[];
  /** Optional user-supplied default. Built-ins intentionally do not define one. */
  defaultModel?: string;
  /** Public/anonymous fallback key (e.g. opencode "public") so the model picker
   *  can list free models with no personal key. Not a secret. */
  defaultApiKey?: string;
}

function buildProviderCatalog(): ProviderEntry[] {
  const out: ProviderEntry[] = [];
  // 1. Built-in providers from the code modules (picker-visible only). Endpoint
  //    MAY be empty (the generic openai-compatible / opencode pick it
  //    up at config time) — only label/hint/envKey are structurally required.
  for (const p of BUILTIN_PROVIDERS) {
    if (!p.pickerVisible || !p.label || !p.hint || !p.envKey) continue;
    out.push({ id: p.id, label: p.label, hint: p.hint, endpoint: p.endpoint, envKey: p.envKey, local: p.local, models: [], defaultApiKey: p.defaultApiKey });
  }
  // 2. Code-defined providers contributed by loaded extensions. A built-in id
  //    still wins (skip), so the core modules stay authoritative.
  const seen = new Set(out.map((p) => p.id));
  for (const p of extensionProviders()) {
    if (!p.pickerVisible || !p.label || !p.hint || !p.envKey) continue;
    if (PROVIDER_REGISTRY.hasBuiltin(p.id) || seen.has(p.id)) continue;
    out.push({ id: p.id, label: p.label, hint: p.hint, endpoint: p.endpoint, envKey: p.envKey, local: p.local, models: [], defaultApiKey: p.defaultApiKey });
    seen.add(p.id);
  }
  // 3. User-added providers from ~/.config/brainrouter/providers.json. A built-in
  //    id wins (skip), so the code modules stay authoritative.
  const cfg = loadProvidersConfig();
  for (const [id, entry] of Object.entries(cfg.providers)) {
    if (entry.pickerVisible !== true || PROVIDER_REGISTRY.hasBuiltin(id) || seen.has(id)) continue;
    if (!entry.label || !entry.hint || !entry.endpoint || !entry.envKey) continue;
    out.push({ id, label: entry.label, hint: entry.hint, endpoint: entry.endpoint, envKey: entry.envKey, local: entry.local === true, models: entry.models ?? [], defaultModel: entry.defaultModel });
    seen.add(id);
  }
  return out;
}

export const PROVIDER_CATALOG: ProviderEntry[] = buildProviderCatalog();

/**
 * Rebuild PROVIDER_CATALOG in place after extensions load (the const binding is
 * stable; consumers read the same array, refreshed). Called by the extension
 * loader once `registerProvider` contributions are in.
 */
export function refreshProviderCatalog(): void {
  const next = buildProviderCatalog();
  PROVIDER_CATALOG.length = 0;
  PROVIDER_CATALOG.push(...next);
}

/** Look up a provider entry by stable id (undefined when not in the catalog). */
export function findProvider(id: string): ProviderEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

/**
 * Pre-detect which provider already has a usable key in the environment, in
 * PROVIDER_CATALOG (precedence) order — so a first-time user with a key set
 * gets that provider pre-selected. Returns the first hit.
 */
export function detectProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderEntry | undefined {
  for (const provider of PROVIDER_CATALOG) {
    const value = env[provider.envKey];
    if (value && value.trim().length > 0) return provider;
  }
  return undefined;
}

/** Wizard API-key validation: warn-not-block on unrecognised key shapes. */
export type ApiKeyValidation =
  | { kind: 'accept'; warning?: string }
  | { kind: 'reject'; reason: string };

function loadKnownPrefixes(): string[] {
  const cfg = loadApiKeyPrefixesConfig();
  return cfg.known.map((e) => e.prefix);
}

export function validateApiKey(raw: string, provider: ProviderEntry): ApiKeyValidation {
  const key = raw.trim();
  if (provider.local) return { kind: 'accept' };
  if (key.length === 0) return { kind: 'reject', reason: 'API key is required for cloud providers.' };
  if (key.length < 16) return { kind: 'reject', reason: `Key is ${key.length} characters — that looks like a paste error (real provider keys are 32+ chars).` };
  const knownPrefixes = loadKnownPrefixes();
  if (!knownPrefixes.some((p) => key.startsWith(p))) {
    return { kind: 'accept', warning: `Unfamiliar key prefix (expected one of ${knownPrefixes.slice(0, 3).join(', ')}…). Saved as-is — if calls fail, double-check the value from your provider's dashboard.` };
  }
  return { kind: 'accept' };
}

/** Last-four masking for API keys (fixed-width tail so rows align). */
export function maskApiKey(raw: string): string {
  const key = raw.trim();
  if (key.length === 0) return '(none)';
  if (key.length <= 4) return '·'.repeat(key.length);
  return '·'.repeat(8) + key.slice(-4);
}

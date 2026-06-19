/**
 * Built-in provider registry. Each provider is its own module in this folder;
 * this index aggregates them. To add a provider: create `./<id>.ts` exporting a
 * `ProviderDefinition`, then register it in `BUILTIN_PROVIDERS` below.
 *
 * Order is precedence (picker order + env-key auto-detect order): named clouds,
 * then the generic OpenAI-compatible option, then local servers, then hidden
 * tier-ladder-only entries.
 */
import type { ProviderDefinition } from './definition.js';
import { openai } from './openai.js';
import { openaiCompatible } from './openai-compatible.js';
import { opencode } from './opencode.js';
import { lmstudio } from './lmstudio.js';
import { ollama } from './ollama.js';
import { deepseek } from './deepseek.js';

export type { ProviderDefinition } from './definition.js';

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  openai,
  openaiCompatible,
  opencode,
  lmstudio,
  ollama,
  deepseek,
];

/** id → definition, for O(1) lookup (catalog merge, tier ladders, …). */
export const PROVIDER_REGISTRY: ReadonlyMap<string, ProviderDefinition> = new Map(
  BUILTIN_PROVIDERS.map((p) => [p.id, p]),
);

/**
 * Normalize an OpenAI-compatible endpoint to a comparable BASE: drop a trailing
 * slash, a trailing `/chat/completions`, and a trailing `/v1`. This collapses
 * the shapes a config can carry into one key — e.g. both
 * `https://api.deepseek.com` and `https://api.deepseek.com/v1` (DeepSeek's docs
 * say both are valid) normalize to `https://api.deepseek.com`, and a stored
 * full `…/v1/chat/completions` URL collapses the same way.
 */
export function normalizeProviderEndpoint(endpoint: string | undefined | null): string {
  if (!endpoint || typeof endpoint !== 'string') return '';
  let base = endpoint.trim().replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) base = base.slice(0, -'/chat/completions'.length);
  if (base.endsWith('/v1')) base = base.slice(0, -'/v1'.length);
  return base.replace(/\/+$/, '').toLowerCase();
}

/**
 * Resolve the built-in provider whose endpoint MATCHES `endpoint` (normalized),
 * or undefined. This is how a hidden/aliased provider gets selected by the REAL
 * backend it points at, independent of the `provider` id stored in config — e.g.
 * a config with `provider:'openai'` + `endpoint:'https://api.deepseek.com/v1'`
 * resolves to the `deepseek` definition so DeepSeek's effort map + tier ladder
 * actually apply.
 *
 * CLOUD endpoints only. A cloud host (`api.deepseek.com`) uniquely identifies a
 * provider, but a LOCAL port (`localhost:1234`) does NOT — it could be LM Studio,
 * vLLM, llama.cpp, or any OpenAI-compatible server — so inferring a specific
 * provider (and its wire contract, e.g. LM Studio's `reasoningEffort:'ignored'`)
 * from a loopback endpoint would wrongly override an explicit `provider:'openai'`
 * pick. Local providers are therefore matched by their `provider` id, not their
 * endpoint. Providers with an empty endpoint (`openai-compatible`) never match.
 */
export function findProviderByEndpoint(endpoint: string | undefined | null): ProviderDefinition | undefined {
  const key = normalizeProviderEndpoint(endpoint);
  if (!key) return undefined;
  return BUILTIN_PROVIDERS.find((p) => p.endpoint && !p.local && normalizeProviderEndpoint(p.endpoint) === key);
}

/** Loopback host detection (port-agnostic), the single source of truth for "is
 *  this endpoint a local server". Accepts the host forms a local LLM server
 *  binds to: localhost / 127.0.0.1 / 0.0.0.0 / [::1]. */
export function isLoopbackEndpoint(endpoint: string | undefined | null): boolean {
  if (!endpoint || typeof endpoint !== 'string') return false;
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\b|\/|$)/i.test(endpoint.trim());
}

/** The throwaway bearer sent to a LOCAL server that requires *an* Authorization
 *  header but ignores its value (LM Studio / Ollama: "required but ignored").
 *  One shared constant so every surface (chat call, model-list fetch) agrees. */
export const LOCAL_PLACEHOLDER_KEY = 'local';

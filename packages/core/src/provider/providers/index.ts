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
import { ProviderRegistry } from './providerRegistry.js';
import { openai } from './openai/index.js';
import { anthropic } from './anthropic/index.js';
import { gemini } from './gemini/index.js';
import { openrouter } from './openrouter/index.js';
import { zenmux } from './zenmux/index.js';
import { groq } from './groq/index.js';
import { azure } from './azure/index.js';
import { openaiCompatible } from './openai-compatible/index.js';
import { opencode } from './opencode/index.js';
import { lmstudio } from './lmstudio/index.js';
import { ollama } from './ollama/index.js';
import { deepseek } from './deepseek/index.js';
import { externalAgent } from './external-agent/index.js';
import { cohere, voyage, jina } from './rerankEmbed/index.js';
import { stripTrailingSlashes } from '../../util/trimEdges.js';

export type { ProviderDefinition } from './definition.js';

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  // Named clouds first (picker order + env-key auto-detect precedence)…
  openai,
  anthropic,
  gemini,
  openrouter,
  zenmux,
  groq,
  azure,
  // …then the generic OpenAI-compatible option + hosted gateway…
  openaiCompatible,
  opencode,
  // …then local servers, then hidden tier-ladder-only entries.
  lmstudio,
  ollama,
  deepseek,
  // ADR-047 D2 — the subprocess engine (no HTTP; model = a cli.agents.hosted name).
  externalAgent,
  // Embedding / reranker vendors (hidden from the chat picker; capability-tagged).
  cohere,
  voyage,
  jina,
];

/** Provider serves this model kind. Omitted `capabilities` ⇒ chat-only (the default). */
export function providerServesKind(p: ProviderDefinition, kind: 'chat' | 'embedding' | 'reranker'): boolean {
  return (p.capabilities ?? ['chat']).includes(kind);
}

/** Providers that serve a given model kind — the per-kind catalog for a picker. */
export function providersForKind(kind: 'chat' | 'embedding' | 'reranker'): ProviderDefinition[] {
  return BUILTIN_PROVIDERS.filter((p) => providerServesKind(p, kind));
}

/** id → definition, for O(1) lookup (catalog merge, tier ladders, …). */
export const PROVIDER_REGISTRY = new ProviderRegistry(BUILTIN_PROVIDERS);

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
  let base = stripTrailingSlashes(endpoint.trim());
  if (base.endsWith('/chat/completions')) base = base.slice(0, -'/chat/completions'.length);
  if (base.endsWith('/v1')) base = base.slice(0, -'/v1'.length);
  return stripTrailingSlashes(base).toLowerCase();
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
  // Iterate the LIVE registry, not just `BUILTIN_PROVIDERS`, so a declarative
  // provider (ADR-047 D1) or an extension provider registered with a real cloud
  // endpoint resolves by endpoint too — the same way `deepseek` does by id.
  // Built-ins are inserted before dynamic registrations in the merged view, so a
  // built-in still wins when two definitions share a normalized endpoint.
  for (const p of PROVIDER_REGISTRY.values()) {
    if (p.endpoint && !p.local && normalizeProviderEndpoint(p.endpoint) === key) return p;
  }
  return undefined;
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

/**
 * Append an Azure-style `api-version` query param to a request URL when the
 * provider config carries one (the OpenAI-compatible providers that don't need
 * it leave it blank, so the URL is returned unchanged). Picks the right
 * separator: `&` when the URL already has a query string, else `?`. Shared by
 * the chat call (agent) and the model-list fetch (desktop host) so both agree.
 */
export function withApiVersion(url: string, apiVersion: string | undefined | null): string {
  const v = (apiVersion ?? '').trim();
  if (!v) return url;
  return url + (url.includes('?') ? '&' : '?') + 'api-version=' + encodeURIComponent(v);
}

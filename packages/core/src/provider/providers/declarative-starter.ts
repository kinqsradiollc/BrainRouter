/**
 * ADR-047 D1 — the packaged starter set of declarative providers.
 *
 * These are well-known OpenAI-compatible vendors that carry no behavioural
 * quirk worth a code module: a name, an endpoint, an env-key. They ship as DATA
 * (this array is a plain declarative payload — no logic) and are registered into
 * the live `ProviderRegistry` at boot exactly like a user's `cli.customProviders`
 * entry, which is the whole point: a vendor reaches "routing turns" without a
 * TypeScript module or a release.
 *
 * Model *lists* are never seeded here — each endpoint's live `GET /models`
 * drives them (the golden rule). `defaultModels` is intentionally omitted so a
 * stale literal can never shadow what the vendor actually serves.
 *
 * An id that later becomes a built-in code module is skipped at registration
 * (the code module wins), so promoting a vendor from data to code is safe.
 */
import type { DeclarativeProviderEntry } from '../../config/configTypes.js';

export const STARTER_DECLARATIVE_PROVIDERS: readonly DeclarativeProviderEntry[] = [
  {
    id: 'together',
    label: 'Together AI',
    hint: 'cloud · api.together.xyz/v1 (OpenAI-compatible)',
    endpoint: 'https://api.together.xyz/v1',
    envKey: 'TOGETHER_API_KEY',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    hint: 'cloud · api.fireworks.ai/inference/v1 (OpenAI-compatible)',
    endpoint: 'https://api.fireworks.ai/inference/v1',
    envKey: 'FIREWORKS_API_KEY',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    hint: 'cloud · api.mistral.ai/v1 (OpenAI-compatible)',
    endpoint: 'https://api.mistral.ai/v1',
    envKey: 'MISTRAL_API_KEY',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    hint: 'cloud · api.x.ai/v1 (OpenAI-compatible)',
    endpoint: 'https://api.x.ai/v1',
    envKey: 'XAI_API_KEY',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    hint: 'cloud · api.perplexity.ai (OpenAI-compatible)',
    endpoint: 'https://api.perplexity.ai',
    envKey: 'PERPLEXITY_API_KEY',
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    hint: 'cloud · api.deepinfra.com/v1/openai (OpenAI-compatible)',
    endpoint: 'https://api.deepinfra.com/v1/openai',
    envKey: 'DEEPINFRA_API_KEY',
  },
  {
    id: 'nebius',
    label: 'Nebius AI Studio',
    hint: 'cloud · api.studio.nebius.ai/v1 (OpenAI-compatible)',
    endpoint: 'https://api.studio.nebius.ai/v1',
    envKey: 'NEBIUS_API_KEY',
  },
];

/**
 * Embedding / reranker vendors (ADR-010). These are NOT chat providers, so they
 * are `pickerVisible: false` (hidden from the desktop's chat provider picker) and
 * carry `capabilities` so the BrainRouter dashboard can offer them under its
 * Embeddings / Reranker kinds. All expose an OpenAI-compatible `/v1` base
 * (`/embeddings`, `/rerank` are appended by the caller).
 */
import type { ProviderDefinition } from '../definition.js';

/** Cohere — rerank (its embed API is non-OpenAI-shaped, so reranker only here). */
export const cohere: ProviderDefinition = {
  id: 'cohere',
  label: 'Cohere',
  hint: 'cloud · api.cohere.com · reranking',
  endpoint: 'https://api.cohere.com/v1',
  envKey: 'COHERE_API_KEY',
  local: false,
  pickerVisible: false,
  capabilities: ['reranker'],
  defaultModels: ['rerank-v3.5', 'rerank-english-v3.0', 'rerank-multilingual-v3.0'],
};

/** Voyage AI — embeddings + reranking (OpenAI-compatible /v1). */
export const voyage: ProviderDefinition = {
  id: 'voyage',
  label: 'Voyage AI',
  hint: 'cloud · api.voyageai.com · embeddings + reranking',
  endpoint: 'https://api.voyageai.com/v1',
  envKey: 'VOYAGE_API_KEY',
  local: false,
  pickerVisible: false,
  capabilities: ['embedding', 'reranker'],
  defaultModels: ['rerank-2', 'rerank-2-lite', 'voyage-3', 'voyage-3-lite', 'voyage-3-large'],
};

/** Jina AI — embeddings + reranking (OpenAI-compatible /v1). */
export const jina: ProviderDefinition = {
  id: 'jina',
  label: 'Jina AI',
  hint: 'cloud · api.jina.ai · embeddings + reranking',
  endpoint: 'https://api.jina.ai/v1',
  envKey: 'JINA_API_KEY',
  local: false,
  pickerVisible: false,
  capabilities: ['embedding', 'reranker'],
  defaultModels: ['jina-reranker-v2-base-multilingual', 'jina-embeddings-v3'],
};

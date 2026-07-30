import type { ProviderDefinition } from '../definition.js';

/** OpenAI-compatible — the GENERIC provider for any `/v1` endpoint that isn't a
 *  named built-in (gateways, self-hosted, vLLM, LiteLLM, OpenRouter, a cloud
 *  MiniMax/DeepSeek/Groq gateway, …). The user supplies the endpoint + key; the
 *  live GET /models drives the model list. No fixed endpoint or curated models. */
export const openaiCompatible: ProviderDefinition = {
  id: 'openai-compatible',
  label: 'OpenAI-compatible (custom)',
  hint: 'any /v1 endpoint — you provide the base URL + key',
  endpoint: '',
  envKey: 'OPENAI_API_KEY',
  local: false,
  pickerVisible: true,
  capabilities: ['chat', 'embedding', 'reranker'],
  // reasoningEffort + effortValueMap are intentionally UNDECLARED: the endpoint
  // is user-supplied and its capabilities are unknown, so we assume OpenAI
  // semantics and inherit the shared DEFAULT_EFFORT_VALUE_MAP at resolve time
  // rather than guess a contract this generic provider can't promise.
};

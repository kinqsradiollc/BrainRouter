import { DEFAULT_EFFORT_VALUE_MAP, type ProviderDefinition } from './definition.js';

/** OpenAI — the canonical cloud provider. Any OpenAI-compatible `/v1` endpoint
 *  can also be reached via the `openai-compatible` provider. */
export const openai: ProviderDefinition = {
  id: 'openai',
  label: 'OpenAI',
  hint: 'cloud · api.openai.com · or any compatible /v1 endpoint',
  endpoint: 'https://api.openai.com/v1',
  envKey: 'OPENAI_API_KEY',
  local: false,
  pickerVisible: true,
  requestFormat: 'responses',
  // Declared explicitly so the canonical provider STATES its own contract rather
  // than relying on the runtime fallback — `reasoning_effort` is accepted for
  // reasoning models (gpt-5/o-series) and `xhigh` caps at `high` (no higher tier
  // on chat-completions). These ARE the shared default the other modules describe
  // their maps against.
  reasoningEffort: 'param',
  effortValueMap: DEFAULT_EFFORT_VALUE_MAP,
  // OpenAI ERRORS (not ignores) on reasoning_effort for a non-reasoning model
  // (e.g. gpt-4o, gpt-5-chat-latest), so it MUST gate by the reasoning-model
  // allowlist. Every other OpenAI-compatible provider defaults to 'any'.
  effortModelGate: 'reasoning-only',
};

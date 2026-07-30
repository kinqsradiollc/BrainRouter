import type { ProviderDefinition } from '../definition.js';

/** Groq — fast cloud inference over an OpenAI-compatible API at
 *  `https://api.groq.com/openai/v1` (model list from `/openai/v1/models`).
 *
 *  Reasoning fields UNDECLARED: Groq accepts-and-ignores `reasoning_effort` for
 *  models that can't use it, so the shared conservative default applies. */
export const groq: ProviderDefinition = {
  id: 'groq',
  label: 'Groq',
  hint: 'cloud · api.groq.com/openai/v1 · fast inference',
  endpoint: 'https://api.groq.com/openai/v1',
  envKey: 'GROQ_API_KEY',
  local: false,
  pickerVisible: true,
};

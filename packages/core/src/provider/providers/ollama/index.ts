import type { ProviderDefinition } from '../definition.js';

/** Ollama — a LOCAL OpenAI-compatible server (its OpenAI shim lives at
 *  `/v1`; model tags come from `/v1/models`). A blank API key is fine. */
export const ollama: ProviderDefinition = {
  id: 'ollama',
  label: 'Ollama (local)',
  hint: 'local · http://localhost:11434 · blank API key OK',
  endpoint: 'http://localhost:11434/v1',
  envKey: 'OLLAMA_API_KEY',
  local: true,
  pickerVisible: true,
  capabilities: ['chat', 'embedding'],
  // Ollama's OpenAI-compat /v1 accepts `reasoning_effort` (high|medium|low|none);
  // it has no `minimal`/`xhigh`, so xhigh maps down to high.
  reasoningEffort: 'param',
  effortValueMap: { low: 'low', high: 'high', xhigh: 'high' },
};

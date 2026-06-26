import type { ProviderDefinition } from './definition.js';

/** OpenRouter — an OpenAI-compatible gateway that fronts many model providers
 *  under one `/api/v1` base (model list from `/api/v1/models`). One key, many
 *  models; the live `/models` drives the picker.
 *
 *  Reasoning fields UNDECLARED: OpenRouter forwards/normalizes provider params
 *  per upstream model, so we inherit the shared default rather than fix a single
 *  contract across a heterogeneous catalog. */
export const openrouter: ProviderDefinition = {
  id: 'openrouter',
  label: 'OpenRouter',
  hint: 'cloud · openrouter.ai/api/v1 · gateway to many models',
  endpoint: 'https://openrouter.ai/api/v1',
  envKey: 'OPENROUTER_API_KEY',
  local: false,
  pickerVisible: true,
};

import type { ProviderDefinition } from '../definition.js';

/** opencode — opencode's hosted "Zen" OpenAI-compatible gateway. Endpoint is a
 *  sensible default; correct the base URL for your account/plan if it differs. */
export const opencode: ProviderDefinition = {
  id: 'opencode',
  label: 'opencode (Zen gateway)',
  hint: 'cloud · opencode.ai gateway · OPENCODE_API_KEY',
  endpoint: 'https://opencode.ai/zen/v1',
  envKey: 'OPENCODE_API_KEY',
  local: false,
  pickerVisible: true,
  // Zen accepts reasoning_effort for OpenAI-family models, INCLUDING xhigh.
  reasoningEffort: 'param',
  effortValueMap: { low: 'low', high: 'high', xhigh: 'xhigh' },
  // Free Zen models work with the anonymous bearer "public" when no personal key
  // is set. Community-reported, NOT a documented contract — a real signed-in
  // OPENCODE_API_KEY always takes precedence and is the supported path.
  defaultApiKey: 'public',
};

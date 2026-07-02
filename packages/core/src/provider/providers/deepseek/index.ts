import type { ProviderDefinition } from '../definition.js';

/** DeepSeek — HIDDEN from the picker (`pickerVisible:false`). DeepSeek is reached
 *  through the OpenAI-compatible flow (pick OpenAI, point the endpoint at
 *  api.deepseek.com — both `…/v1` and the bare host work), which leaves
 *  `config.provider` as `openai`. The DeepSeek-specific effort DATA below is
 *  still selected because `activeProviderDef` is ENDPOINT-AWARE: a config whose
 *  endpoint matches api.deepseek.com resolves to THIS definition regardless of
 *  the stored provider id (see `findProviderByEndpoint`). Tier ladders are
 *  config-driven, not defined in provider modules.
 *
 *  Effort values below are per DeepSeek's thinking-mode docs (V4): low/medium are
 *  mapped to `high` and `xhigh` to `max` server-side; we send `high`/`max`
 *  directly (NOT collapsed into a thinking flag) so the requested level is kept. */
export const deepseek: ProviderDefinition = {
  id: 'deepseek',
  label: 'DeepSeek',
  hint: 'cloud · api.deepseek.com/v1 (via OpenAI-compatible)',
  endpoint: 'https://api.deepseek.com/v1',
  envKey: 'DEEPSEEK_API_KEY',
  local: false,
  pickerVisible: false,
  // V4-class models accept reasoning_effort but only high|max — so low→high and
  // xhigh→max (NOT downgraded to high). The always-on `deepseek-reasoner` (R1)
  // rejects the field entirely and is excluded by name in resolveWireEffort().
  reasoningEffort: 'param',
  effortValueMap: { low: 'high', high: 'high', xhigh: 'max' },
};

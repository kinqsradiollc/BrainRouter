import type { ProviderDefinition } from '../definition.js';

/** ZenMux — an OpenAI-compatible model gateway (zenmux.ai) fronting many
 *  upstream providers under one `/api/v1` base (model list from
 *  `/api/v1/models`). One key, many models; the live `/models` drives the
 *  picker.
 *
 *  Reasoning fields UNDECLARED: ZenMux forwards/normalizes provider params per
 *  upstream model, so we inherit the shared conservative default rather than fix
 *  a single contract across a heterogeneous catalog. */
export const zenmux: ProviderDefinition = {
  id: 'zenmux',
  label: 'ZenMux',
  hint: 'cloud · zenmux.ai/api/v1 · gateway to many models',
  endpoint: 'https://zenmux.ai/api/v1',
  envKey: 'ZENMUX_API_KEY',
  local: false,
  pickerVisible: true,
};

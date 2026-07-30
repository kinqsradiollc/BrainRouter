import type { ProviderDefinition } from '../definition.js';

/** Anthropic (Claude) — reached over Anthropic's OpenAI-compatible surface at
 *  `https://api.anthropic.com/v1` (`callOpenAI` appends `/chat/completions`; the
 *  model list comes from `/v1/models`). The 0.3.9 note "route Claude via an
 *  OpenAI-compatible gateway" is satisfied directly by Anthropic's own compat
 *  endpoint — no third-party gateway required.
 *
 *  Reasoning fields are intentionally UNDECLARED: the compat shim's handling of
 *  `reasoning_effort` is not a documented contract, so we inherit the shared
 *  conservative default (accept-and-ignore for models that can't use it) rather
 *  than promise a wire behavior we can't guarantee. */
export const anthropic: ProviderDefinition = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  hint: 'cloud · api.anthropic.com/v1 · OpenAI-compatible',
  endpoint: 'https://api.anthropic.com/v1',
  envKey: 'ANTHROPIC_API_KEY',
  local: false,
  pickerVisible: true,
};

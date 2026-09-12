import type { ProviderDefinition } from '../definition.js';

/** Matilda (Maincode) — an Australian hosted model service (matilda.maincode.com),
 *  served onshore from Melbourne. BrainRouter integrates its OpenAI-compatible
 *  surface: base `https://matilda.maincode.com/api/v1`, so chat is
 *  `…/api/v1/chat/completions` and the live model list is `…/api/v1/models`
 *  (both confirmed against the docs + a live probe; ADR-058). One `mc_live_`
 *  Bearer key, and the picker is driven by the live `/models` — structurally
 *  identical to the ZenMux shape.
 *
 *  Reasoning fields UNDECLARED: Matilda's models are not publicly enumerated and
 *  their per-model reasoning contract is resolved at runtime from `/models`
 *  metadata, so we inherit the shared conservative `DEFAULT_EFFORT_VALUE_MAP`
 *  rather than fix a contract we cannot yet promise. Matilda's NATIVE
 *  Responses-like surface (server-side `conversationId` history) is intentionally
 *  NOT modelled here — it clashes with BrainRouter's stateless, full-`messages[]`
 *  turns (ADR-058 D1). */
export const matilda: ProviderDefinition = {
  id: 'matilda',
  label: 'Matilda (Maincode)',
  hint: 'cloud · matilda.maincode.com/api/v1 · Australian sovereign models',
  endpoint: 'https://matilda.maincode.com/api/v1',
  envKey: 'MATILDA_API_KEY',
  local: false,
  pickerVisible: true,
};

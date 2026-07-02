import type { ProviderDefinition } from '../definition.js';

/** Google Gemini — reached over Gemini's OpenAI-compatible endpoint
 *  (`/v1beta/openai`; `callOpenAI` appends `/chat/completions`, and the model
 *  list derives from `/v1beta/openai/models`). Key from Google AI Studio.
 *
 *  Reasoning fields are UNDECLARED (inherit the conservative default) — Gemini's
 *  compat layer accepts-and-ignores `reasoning_effort` for models that can't use
 *  it, so no provider-specific contract is asserted here. */
export const gemini: ProviderDefinition = {
  id: 'gemini',
  label: 'Google Gemini',
  hint: 'cloud · generativelanguage.googleapis.com · OpenAI-compatible',
  endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
  envKey: 'GEMINI_API_KEY',
  local: false,
  pickerVisible: true,
};

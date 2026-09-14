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
  // ADR-058 D13 — the DEFAULT wire is Matilda's NATIVE chat surface
  // (`…/api/chat`, SSE): it is the only surface on which the model calls tools
  // (as DSML blocks in the text — see ./dsml.ts and ./nativeChat.ts), it accepts
  // longer messages, and it chats just as well. The OpenAI-compatible surface
  // stays one override away (`cli.providerRequestFormat.matilda =
  // 'chat-completions'`) — it ignores `tools` entirely, so it is chat-only.
  requestFormat: 'matilda-chat',
  // Matilda's OpenAI-compatible endpoint validates the request body STRICTLY and
  // rejects any unexpected property with a 400 ("property <x> should not exist") —
  // verified against the live endpoint for both `reasoning_effort` and the nested
  // `reasoning` object. So we never send an effort field to it; BrainRouter's own
  // system-prompt effort overlay still conveys depth. (Without this, every turn
  // that carries a non-default `/effort` would 400 at Matilda.)
  reasoningEffort: 'unsupported',
  // The endpoint also enforces hard per-request limits, measured live to the
  // byte (ADR-058 §6): a 64 KiB request body — 65 536 bytes → 200, 65 537 →
  // 403 `{"error":"forbidden"}`, checked at the edge BEFORE any validation
  // (which is why an oversized agent turn only ever surfaced a 403, never a
  // 413) — and at most 16 000 characters of `content` per message, for every
  // role (16 001 → 400 "must be shorter than or equal to 16000"). A BrainRouter
  // agent turn is ~120 KB (a ~22k-char system prompt + ~104 tools), so the
  // transport shapes the request to fit: messages capped, tools fitted by
  // relevance to the remaining bytes.
  limits: { maxBodyBytes: 65_536, maxMessageChars: 16_000 },
  // Tool calls arrive as DSML text on EVERY surface the model speaks through
  // (a compat-wire turn once ended on a visible
  // `<｜DSML｜tool_call> <｜DSML｜parameter name="tool">list_dir…` block).
  toolCallMarkup: 'dsml',
};

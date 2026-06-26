/**
 * MODEL reasoning knowledge — the axis ORTHOGONAL to provider id.
 *
 * Whether a model is a reasoning model, whether it's a non-reasoning chat variant
 * that REJECTS the reasoning_effort field, whether it natively accepts the `xhigh`
 * effort tier, whether it reasons always-on — these are all keyed on the model
 * NAME, because the same model behaves the same no matter which provider serves it
 * (the same `gpt-oss-20b` is a reasoning model on LM Studio, Ollama, or a gateway).
 *
 * Provider id → wire mechanism (the `reasoningEffort` mode + `effortValueMap`)
 * lives in `../providers/`; this is the complementary model-name → capability
 * layer. Keeping it ONE central list (never duplicated onto provider modules)
 * avoids the "model rule hardcoded on a provider id" bug class.
 *
 * The preferred signal is live provider metadata from `GET /models` when the
 * endpoint exposes it. Name heuristics are a compatibility fallback for endpoints
 * that only return `{ id }`. This keeps new reasoning-capable models usable
 * without waiting for BrainRouter to add their names to a static list.
 */

export interface ModelReasoningCapabilities {
  /** The model has a reasoning/thinking mode. */
  reasoning?: true;
  /** The model explicitly advertises a reasoning-effort request parameter. */
  effort?: true;
  /** The model advertises the `xhigh` effort tier. */
  xhigh?: true;
  /**
   * The advertised reasoning-effort VOCABULARY from live `/models` metadata
   * (lowercased), e.g. `['on','off']` for a binary model or
   * `['low','medium','high']` for a graded one. Drives binary on/off detection
   * so a model that only accepts `on`/`off` is never sent a graded `high`/`low`
   * value it would reject. Empty/absent = vocabulary unknown (fall back to the
   * provider's effortValueMap).
   */
  efforts?: string[];
}

/** Graded effort literals — a model advertising any of these accepts the OpenAI
 *  reasoning_effort param (vs a binary on/off toggle). */
const GRANULAR_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'extra_high', 'extra-high']);

const MODEL_REASONING_CAPABILITIES = new Map<string, ModelReasoningCapabilities>();

function keyForms(model: string | undefined | null): string[] {
  const raw = (model ?? '').trim().toLowerCase();
  if (!raw) return [];
  const bare = normalizeModelName(raw);
  return raw === bare ? [bare] : [raw, bare];
}

export function registerModelReasoningCapabilities(model: string | undefined | null, capabilities: ModelReasoningCapabilities): void {
  const hasSignal = capabilities.reasoning || capabilities.effort || capabilities.xhigh || !!capabilities.efforts?.length;
  if (!hasSignal) return;
  for (const key of keyForms(model)) {
    const prev = MODEL_REASONING_CAPABILITIES.get(key) ?? {};
    const merged: ModelReasoningCapabilities = { ...prev, ...capabilities };
    // Union the advertised vocabulary so a thinner source (e.g. a bare
    // /v1/models row) never clobbers a richer one (LM Studio's native enrich).
    const efforts = Array.from(new Set([...(prev.efforts ?? []), ...(capabilities.efforts ?? [])]));
    if (efforts.length) merged.efforts = efforts;
    MODEL_REASONING_CAPABILITIES.set(key, merged);
  }
}

export function lookupModelReasoningCapabilities(model: string | undefined | null): ModelReasoningCapabilities | undefined {
  for (const key of keyForms(model)) {
    const hit = MODEL_REASONING_CAPABILITIES.get(key);
    if (hit) return hit;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value.toLowerCase()];
  if (Array.isArray(value)) return value.flatMap((v) => stringValues(v));
  const record = asRecord(value);
  return record ? Object.values(record).flatMap((v) => stringValues(v)) : [];
}

function hasReasoningToken(value: unknown): boolean {
  return stringValues(value).some((s) => /\b(reasoning|thinking)\b/.test(s) || s === 'reason');
}

function hasReasoningEffortToken(value: unknown): boolean {
  return stringValues(value).some((s) => /reasoning[_\-. ]?effort/.test(s) || s === 'reasoning.effort');
}

function hasXhighToken(value: unknown): boolean {
  return stringValues(value).some((s) => s === 'xhigh' || s === 'extra_high' || s === 'extra-high');
}

/**
 * Best-effort parser for live `/models` metadata. Providers are not consistent:
 * LM Studio reports `capabilities.reasoning`, gateways often expose
 * `supported_parameters`, and some use flat booleans like `supports_reasoning`.
 * We only return POSITIVE hints; absent/negative metadata does not override the
 * static fallback patterns because another provider may serve the same model id
 * with a thinner `/models` payload.
 */
export function inferModelReasoningCapabilities(raw: unknown): ModelReasoningCapabilities {
  const root = asRecord(raw);
  if (!root) return {};
  const out: ModelReasoningCapabilities = {};
  const caps = asRecord(root.capabilities);
  const metadata = asRecord(root.metadata) ?? asRecord(root.meta);
  const reasoning = caps?.reasoning ?? root.reasoning ?? metadata?.reasoning;

  if (reasoning === true || !!asRecord(reasoning) || Array.isArray(reasoning) || hasReasoningToken(reasoning)) out.reasoning = true;
  if (caps && Object.prototype.hasOwnProperty.call(caps, 'reasoning')) out.reasoning = true;
  if (metadata && Object.prototype.hasOwnProperty.call(metadata, 'reasoning')) out.reasoning = true;
  if (hasReasoningToken(root.capabilities) || hasReasoningToken(root.features) || hasReasoningToken(metadata?.capabilities)) {
    out.reasoning = true;
  }
  if (root.supports_reasoning === true || root.supportsThinking === true || root.supports_thinking === true) {
    out.reasoning = true;
  }
  if (
    root.reasoning_effort === true ||
    caps?.reasoning_effort === true ||
    hasReasoningEffortToken(root.supported_parameters) ||
    hasReasoningEffortToken(root.supported_params) ||
    hasReasoningEffortToken(root.parameters) ||
    hasReasoningEffortToken(metadata?.supported_parameters)
  ) {
    out.reasoning = true;
    out.effort = true;
  }
  if (
    hasXhighToken(root.supported_reasoning_efforts) ||
    hasXhighToken(root.reasoning_effort) ||
    hasXhighToken(caps?.reasoning_effort) ||
    hasXhighToken(metadata?.supported_reasoning_efforts)
  ) {
    out.reasoning = true;
    out.effort = true;
    out.xhigh = true;
  }
  // Capture the advertised effort VOCABULARY (the literal allowed values) from
  // whichever shape the endpoint exposes: a flat `supported_reasoning_efforts`
  // array (generic OpenAI-compat / gateways) or LM Studio's nested
  // `capabilities.reasoning.allowed_options`. A non-empty set means the model
  // reasons; if it includes a graded literal it also accepts the effort param.
  const efforts = collectEffortVocab(root, caps, metadata);
  if (efforts.length) {
    out.efforts = efforts;
    out.reasoning = true;
    if (efforts.some((e) => GRANULAR_EFFORTS.has(e))) out.effort = true;
  }
  return out;
}

/** Pull lowercased allowed-effort literals from the common `/models` shapes. */
function collectEffortVocab(
  root: Record<string, unknown>,
  caps: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): string[] {
  const sources: unknown[] = [
    root.supported_reasoning_efforts,
    metadata?.supported_reasoning_efforts,
    asRecord(caps?.reasoning)?.allowed_options,
    asRecord(root.reasoning)?.allowed_options,
    asRecord(metadata?.reasoning)?.allowed_options,
  ];
  const out = new Set<string>();
  for (const src of sources) {
    if (Array.isArray(src)) {
      for (const v of src) if (typeof v === 'string' && v.trim()) out.add(v.trim().toLowerCase());
    }
  }
  return Array.from(out);
}

/**
 * True iff the model's advertised vocabulary is a binary on/off toggle with NO
 * graded tier. This is capability evidence only: the request resolver still
 * checks the active provider before putting `on` on the wire, because the same
 * model id can be served by a provider whose API accepts only graded literals
 * like `low|high|xhigh`. `google/gemma-*-qat` on LM Studio is the canonical
 * binary case. Capability-driven (from /models); no model names hardcoded.
 */
export function isBinaryReasoningModel(model: string | undefined): boolean {
  const efforts = lookupModelReasoningCapabilities(model)?.efforts;
  if (!efforts || efforts.length === 0) return false;
  const hasToggle = efforts.some((v) => v === 'on' || v === 'off');
  const hasGranular = efforts.some((v) => GRANULAR_EFFORTS.has(v));
  return hasToggle && !hasGranular;
}

/** Test hook. */
export function _resetModelReasoningCapabilities(): void {
  MODEL_REASONING_CAPABILITIES.clear();
}

/**
 * Lower-case + strip any `<vendor>/` prefix (keep the segment after the LAST `/`)
 * so `openai/gpt-oss-20b`, `deepseek/deepseek-reasoner`, etc. all match the same
 * bare-name patterns.
 */
export function normalizeModelName(model: string | undefined): string {
  const raw = (model ?? '').toLowerCase();
  return raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
}

/**
 * Non-reasoning CHAT/instruct variants that share a reasoning-model PREFIX but
 * REJECT the reasoning_effort field. OpenAI ERRORS (not silently ignores) when
 * you send reasoning_effort to `gpt-5-chat-latest` / `gpt-5.1-chat`, so these must
 * be excluded even though they match `/^gpt-5/`. The `-chat` segment is the
 * signal (covers `gpt-5-chat`, `gpt-5.1-chat`, `gpt-5-chat-latest`,
 * `deepseek-chat`, …).
 */
const NON_REASONING_CHAT = /(?:^|-)chat(?:-latest)?$/;

export function isNonReasoningChatModel(model: string | undefined): boolean {
  return NON_REASONING_CHAT.test(normalizeModelName(model));
}

/**
 * Reasoning-model name patterns. Covers the major reasoning families running
 * through OpenAI-compatible /chat/completions in 2026: OpenAI's gpt-5 / o-series /
 * open-weight gpt-oss, DeepSeek's R1/R2 + V3/V4 thinking variants, Alibaba's Qwen3,
 * Mistral's Magistral, Microsoft's Phi-4-reasoning. The `reasoning`/`thinking`
 * catch-alls pick up new entrants we haven't enumerated.
 */
const REASONING_PATTERNS = [
  /^gpt-5/,            // gpt-5, gpt-5-mini, gpt-5-pro, gpt-5.1, gpt-5.x-codex(-max)
  /^o[134](-|$|\.)/,   // o1, o3, o4 and dated / sized variants
  /^gpt-oss/,          // gpt-oss-20b / 120b (LM Studio 0.3.29+, Ollama, llama.cpp)
  /^deepseek-r[12]/,   // DeepSeek R1, R2
  /^deepseek-v[34]/,   // DeepSeek V3.1+, V4 reasoning variants
  /^qwen3/,            // Qwen3 reasoning variants (LM Studio, Ollama)
  /^magistral/,        // Mistral Magistral (small/medium reasoning)
  /reasoning/,         // catch-all for `phi-4-reasoning`, `*-reasoning-plus`, …
  /thinking/,          // catch-all for `qwen3-30b-a3b-thinking`, `*-thinking-*`, …
];

/**
 * True iff `model` is a reasoning model that ACCEPTS the reasoning_effort field.
 * Non-reasoning chat variants are excluded FIRST (they'd error), then the model
 * is matched against the reasoning-family patterns.
 */
export function isReasoningModel(model: string | undefined): boolean {
  const m = normalizeModelName(model);
  if (isNonReasoningChatModel(m)) return false;
  const live = lookupModelReasoningCapabilities(m);
  if (live?.reasoning || live?.effort) return true;
  return REASONING_PATTERNS.some((re) => re.test(m));
}

/**
 * Always-on reasoning models that reason by default and REJECT the
 * reasoning_effort field entirely — send NOTHING. DeepSeek's R1 `deepseek-reasoner`
 * is the canonical case (its docs omit reasoning_effort and it reasons regardless).
 */
export function isAlwaysOnReasoner(model: string | undefined): boolean {
  return /^deepseek-reasoner/.test(normalizeModelName(model));
}

/**
 * Models that natively accept the `xhigh` reasoning_effort tier (the level ABOVE
 * `high`). OpenAI introduced `xhigh` with gpt-5.1-codex-max and it's supported by
 * gpt-5.2+, gpt-5.4/5.5 and their codex variants — per the OpenAI reasoning docs.
 * For these the conservative `xhigh→high` cap is WRONG (it silently degrades the
 * requested effort), so the resolver passes `xhigh` through instead. The original
 * gpt-5 (2025-08-07) family, gpt-5.1 base/codex, and the o-series do NOT support
 * it — they keep the cap (sending `xhigh` would error there).
 */
const XHIGH_CAPABLE = [
  /^gpt-5\.1-codex-max/,   // the model that introduced xhigh
  /^gpt-5\.[2-9]/,         // gpt-5.2 / 5.3 / 5.4 / 5.5 … and their -codex variants
];

export function modelSupportsXhighEffort(model: string | undefined): boolean {
  const m = normalizeModelName(model);
  if (lookupModelReasoningCapabilities(m)?.xhigh) return true;
  return XHIGH_CAPABLE.some((re) => re.test(m));
}

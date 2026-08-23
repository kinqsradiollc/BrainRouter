/**
 * ProviderDefinition — the shape of one built-in provider, defined in code (one
 * module per provider in this folder, aggregated by ./index.ts). This replaces
 * the old single `config/providers.json` blob: adding/editing a provider is now
 * "create/edit a sibling module + register it in ./index.ts".
 *
 * BrainRouter talks to most providers over the OpenAI-compatible
 * `/chat/completions` wire. Providers can opt into the native Responses API
 * request shape when their canonical endpoint supports it. Provider modules
 * describe endpoint identity + wire behavior only. They must NOT own model
 * catalogs, default model choices, or tier-model ladders; those come from the
 * live `/models` endpoint, saved user config, or bundled/user config data that
 * is intentionally outside this provider-definition layer.
 */
export interface ProviderDefinition {
  /** Stable id used in config.json + the picker (e.g. 'openai', 'lmstudio'). */
  id: string;
  /** Human-readable picker label. */
  label: string;
  /** One-line picker hint shown after the em-dash. */
  hint: string;
  /** OpenAI-compatible BASE URL (ends in /v1 or /api/v1), NOT /chat/completions.
   *  Empty for the generic "openai-compatible" provider — the user supplies it. */
  endpoint: string;
  /** Env var the wizard checks to pre-detect a usable key. */
  envKey: string;
  /** True when the provider runs locally and a blank API key is fine. */
  local: boolean;
  /** Show this provider in the /config + Desktop provider pickers. A provider may
   *  be defined for endpoint-aware wire behavior but hidden from the picker. */
  pickerVisible: boolean;

  /**
   * Which model KINDS this provider serves. Omitted ⇒ `['chat']` (the historical
   * default — every existing provider is a chat provider). Embedding/reranker-only
   * vendors (Cohere, Voyage, Jina) set this to surface in the BrainRouter dashboard's
   * per-kind catalog without appearing in the desktop's chat picker.
   */
  capabilities?: Array<'chat' | 'embedding' | 'reranker'>;

  /**
   * Known model ids for providers whose endpoint does NOT expose a live GET /models
   * (rerank vendors like Cohere, some embedders). Seeds the model picker so the user
   * isn't forced to type them by hand; a live /models still wins when available.
   */
  defaultModels?: string[];

  /**
   * Primary generation wire format:
   *  - 'responses'         — POST /responses with typed `input` items
   *                          (OpenAI-native Codex shape).
   *  - 'chat-completions'  — POST /chat/completions with layered messages.
   *  - 'anthropic-messages'— POST /messages, native Anthropic Messages API.
   *  - 'gemini-generate'   — POST /models/{model}:generateContent, native Gemini.
   * Omitted ⇒ 'chat-completions'. The native formats are normally reached via
   * `cli.providerRequestFormat` opt-in rather than declared as a built-in.
   */
  requestFormat?: 'responses' | 'chat-completions' | 'anthropic-messages' | 'gemini-generate';

  /**
   * How this provider handles reasoning depth over `/v1/chat/completions`:
   *  - 'param'       — accepts a reasoning-effort value for reasoning-capable
   *                    models (further gated by model name + `effortValueMap`;
   *                    wire SHAPE chosen by `effortField`).
   *  - 'ignored'     — the server silently drops the field; don't send it, rely
   *                    on the system-prompt overlay. (No built-in uses this today;
   *                    kept for a server that genuinely ignores effort.)
   *  - 'unsupported' — never send it.
   * Omitted ⇒ 'param' (the OpenAI-compatible default).
   */
  reasoningEffort?: 'param' | 'ignored' | 'unsupported';

  /**
   * Per-provider map from the canonical CLI EffortLevel to the
   * literal wire value this provider accepts, or `null` to omit for that level.
   * `medium` is omitted upstream (CLI default). Omitted ⇒ the shared
   * `DEFAULT_EFFORT_VALUE_MAP` below (the conservative OpenAI map).
   */
  effortValueMap?: Partial<Record<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>;

  /**
   * Optional map for a provider that explicitly documents binary `on`/`off` as
   * a wire-level effort value. Model metadata alone is not enough: some local
   * servers use `on`/`off` to describe thinking-mode toggles while the actual
   * OpenAI-compatible `reasoning_effort` field still accepts graded values.
   * Omitted ⇒ this provider does NOT accept binary effort literals.
   */
  binaryEffortValueMap?: Partial<Record<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>>;

  /**
   * WIRE SHAPE for the reasoning-effort value on `/chat/completions`:
   *  - 'flat'   — the OpenAI top-level `reasoning_effort: '<level>'` field
   *               (OpenAI, DeepSeek, Ollama, opencode — the default).
   *  - 'nested' — the `reasoning: { effort: '<level>' }` object (LM Studio
   *               documents this form on chat-completions; its flat field is
   *               unconfirmed).
   *  - 'both'   — send BOTH shapes; for a server that accepts-and-ignores the
   *               unknown one (LM Studio), this maximises version compatibility.
   * Omitted ⇒ 'flat'. Only consulted when an effort value is actually sent
   * (reasoningEffort:'param' + a reasoning model + a non-medium level).
   */
  effortField?: 'flat' | 'nested' | 'both';

  /**
   * MODEL gating for reasoning effort — which models on this provider get the
   * field when the user sets a non-default `/effort`:
   *  - 'any'            — ANY model (the default). Every OpenAI-compatible server
   *                       accepts-and-ignores reasoning_effort for a model that
   *                       can't use it, so the field is sent broadly and works for
   *                       reasoning models we don't have a name pattern for
   *                       (glm, minimax, kimi, custom finetunes, …).
   *  - 'reasoning-only' — ONLY detected reasoning models (the name allowlist).
   *                       Required for an endpoint that ERRORS on a non-reasoning
   *                       model — OpenAI returns an invalid-parameter error, so
   *                       `openai` opts into this. The endpoint-aware resolver
   *                       means pointing a custom provider at api.openai.com also
   *                       gets this strict treatment.
   * Two model classes are excluded under BOTH gates: always-on reasoners that
   * reject the field (`deepseek-reasoner`) and non-reasoning `*-chat` variants
   * (OpenAI/gateways error on those). Omitted ⇒ 'any'.
   */
  effortModelGate?: 'reasoning-only' | 'any';

  /**
   * Fallback API key injected when the user set NO key (and no env key) — for
   * providers with a public/anonymous free tier (opencode "public"). Local
   * providers leave this unset; they use the `local` blank-key path.
   */
  defaultApiKey?: string;

  /**
   * ADR-043 (egress at the user's edge) — which non-default egress paths this
   * provider's upstream traffic is *allowed* to take. Consumed by the gateway's
   * dialer selection (ADR-043 S3–S5); unread by core routing, so the default
   * (server-side egress) is byte-identical until a per-org policy opts in.
   *  - `vendableToken` — the vendor accepts a short-lived token the client can
   *    use to call it directly (the vended-token path).
   *  - `clientTunnel`  — traffic may be routed via the user's edge over the relay
   *    substrate (the client-tunnel path).
   */
  egressCapabilities?: { vendableToken?: boolean; clientTunnel?: boolean };

  /**
   * ADR-043 — per-provider egress mode. Omitted ⇒ `'server'` (dial upstream from
   * the gateway, as today).
   *  - `'server'`        — gateway dials the vendor (current behaviour).
   *  - `'client-tunnel'` — route via the user's edge over the relay.
   *  - `'vended-token'`  — hand the client a short-lived token to call the vendor.
   *  - `'auto'`          — let the gateway pick from `egressCapabilities` + policy.
   * A mode other than `'server'` is honoured only when `egressCapabilities`
   * permits it and a per-org policy has opted in; otherwise the gateway falls
   * back to `'server'`.
   */
  egressMode?: "server" | "client-tunnel" | "vended-token" | "auto";
}

/**
 * The conservative OpenAI-family effort map: `low→low`, `high→high`,
 * `xhigh→high` (OpenAI's chat-completions has no tier above `high`). This is the
 * shared default a provider inherits when it declares no `effortValueMap` —
 * exported so the canonical `openai` module and the `resolveWireEffort` runtime
 * fallback both reference ONE source of truth instead of re-typing the literal.
 * `medium` is intentionally absent (it never reaches the map — the resolver
 * short-circuits it upstream).
 */
export const DEFAULT_EFFORT_VALUE_MAP: Partial<Record<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>> = {
  low: 'low',
  high: 'high',
  xhigh: 'high',
};

/** Binary reasoning vocabulary for a provider that explicitly documents
 * `on`/`off` as the accepted wire-level effort vocabulary. No built-in provider
 * enables this by default; provider docs must opt in. */
export const DEFAULT_BINARY_EFFORT_VALUE_MAP: Partial<Record<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>> = {
  none: 'off',
  minimal: 'on',
  low: 'on',
  high: 'on',
  xhigh: 'on',
  max: 'on',
};

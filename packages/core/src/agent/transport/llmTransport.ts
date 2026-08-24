// LLM transport + provider wire-format layer — split out of agent.ts (god-file
// breakdown). Byte-identical moves: the LLM payload types, provider/effort
// resolution, request-format selection, Chat-Completions / Responses / native
// payload builders, and the callOpenAI / callOpenAIStream network calls. Pure
// module functions; the Agent class imports these back and re-exports the public
// ones so the agent.ts surface is unchanged.
import type { LLMConfig } from '../../config/config.js';
import { getCliKnobs } from '../../config/config.js';
import { isReasoningModel, isNonReasoningChatModel, isAlwaysOnReasoner, modelSupportsXhighEffort, isBinaryReasoningModel, normalizeModelName } from '../../provider/models/reasoning.js';
import { PROVIDER_REGISTRY, findProviderByEndpoint, isLoopbackEndpoint, LOCAL_PLACEHOLDER_KEY, normalizeProviderEndpoint, withApiVersion } from '../../provider/providers/index.js';
import { DEFAULT_EFFORT_VALUE_MAP } from '../../provider/providers/definition.js';
import type { ProviderDefinition } from '../../provider/providers/definition.js';
import { callExternalAgentEngine } from './externalAgentEngine.js';
import { effortToWireLevel, type EffortLevel } from '../../session/preferences/preferencesStore.js';
import type { PromptLayers } from '../../prompt/systemPrompt.js';
import { computePrefixFingerprint } from '../../context/contextRegions.js';
import { traceEvent } from '../../telemetry/tracing/tracing.js';
import { acquireLLMSlot } from '../../util/concurrency/llmSemaphore.js';
import { parseRetryAfterMs } from '../../mcp/reconnect/reconnect.js';
import { stripTrailingSlashes } from '../../util/trimEdges.js';
import {
  buildAnthropicMessagesPayload, normalizeAnthropicOutput, ANTHROPIC_DEFAULT_MAX_TOKENS,
  buildGeminiGeneratePayload, normalizeGeminiOutput, nativeRequestSpec,
  type NativeBuildInput, type NativeOutput, type NativeRequestFormat,
} from './nativeProviders.js';
import { parseAnthropicMessageStream, parseGeminiStream, type NativeStreamHandlers } from './nativeProviderStream.js';

export interface ChatCompletionPayload {
  model: string;
  messages: any[];
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, any>;
    };
  }>;
  tool_choice?: 'auto' | { type: 'function'; function: { name: string } };
  /**
   * OpenAI Chat Completions reasoning slot — accepted by gpt-5 / o-series.
   * Only set when the user has chosen a non-default `/effort` AND the
   * endpoint+model combo accepts the field (see `supportsReasoningEffortField`).
   * The literal wire value is provider-specific (e.g. `high`, `xhigh`, `max`),
   * resolved by `resolveWireEffort`, so this is a free `string`.
   */
  reasoning_effort?: string;
  /**
   * Nested reasoning-effort form (`reasoning: { effort }`) — the shape LM Studio
   * documents on chat-completions. Emitted alongside / instead of the flat field
   * per the active provider's `effortField`. Same resolved value.
   */
  reasoning?: { effort: string };
}

export interface ResponsesPayload {
  model: string;
  instructions?: string;
  input: any[];
  tools?: Array<{
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, any>;
    strict: boolean;
  }>;
  tool_choice?: 'auto' | { type: 'function'; name: string };
  reasoning?: { effort: string };
  max_output_tokens?: number;
  store: false;
  include: string[];
  parallel_tool_calls?: boolean;
  prompt_cache_key?: string;
  client_metadata?: Record<string, string>;
}

export interface PromptLayeredMessage {
  role: 'system';
  content: string;
  promptLayers?: PromptLayers;
}

// Internal marker lines used by Agent.replaceTaggedSystemMessage to dedupe
// per-turn system messages (briefing, fan-out hint). Strip them before the
// payload reaches the LLM so the model doesn't see the bookkeeping.
const TAG_MARKER_RE = /^<!--brainrouter:[a-z0-9-]+-->\n/;

/** Whether the active model accepts the reasoning_effort field — a config-shaped
 *  wrapper over `isReasoningModel`. Non-reasoning chat variants like
 *  `gpt-5-chat-latest` are excluded: OpenAI ERRORS (not ignores) when they
 *  receive the field. */
export function supportsReasoningEffortField(config: LLMConfig): boolean {
  return isReasoningModel(config.model);
}

/**
 * The active provider's definition. Resolved ENDPOINT-FIRST, then by id:
 *
 *   1. If `config.endpoint` matches a built-in provider's endpoint, use THAT —
 *      this is the real backend, and it's authoritative for wire behaviour
 *      (effort map, tier ladder, locality). It's how DeepSeek (a hidden,
 *      `pickerVisible:false` provider reached as `provider:'openai'` +
 *      `endpoint:'https://api.deepseek.com/v1'`) gets its own effort map
 *      (`xhigh→max`) + ladder instead of silently inheriting OpenAI's.
 *   2. Otherwise fall back to the stored `config.provider` id.
 *
 * Returns undefined for an unknown id + unmatched endpoint (a genuinely custom
 * endpoint) — treated as the OpenAI-compatible default downstream.
 */
export function activeProviderDef(config: LLMConfig): ProviderDefinition | undefined {
  return findProviderByEndpoint(config.endpoint) ?? PROVIDER_REGISTRY.get((config.provider ?? '').toLowerCase());
}

function binaryEffortValueMapFor(def: ProviderDefinition | undefined): ProviderDefinition['binaryEffortValueMap'] | undefined {
  if (def?.binaryEffortValueMap) return def.binaryEffortValueMap;
  return undefined;
}

export type LlmRequestFormat = 'responses' | 'chat-completions' | 'anthropic-messages' | 'gemini-generate' | 'external-agent';

function modelSupportsResponsesFormat(model: string | undefined): boolean {
  const id = normalizeModelName(model ?? '');
  return (
    /^gpt-[0-9]/.test(id) ||
    /^o[134](-|$)/.test(id) ||
    /^chatgpt-/.test(id)
  );
}

export function resolveRequestFormat(config: LLMConfig, effectiveEndpoint?: string): LlmRequestFormat {
  const def = activeProviderDef(config);
  const providerId = (def?.id ?? config.provider ?? '').toLowerCase();
  // PER-PROVIDER WIRE-FORMAT OVERRIDE — user-set in config.json under
  // `cli.providerRequestFormat[<providerId>]`. Validated subset of literals
  // (see `resolveCliKnobs → normalizeProviderRequestFormat`); an unknown
  // provider key is a no-op, so adding overrides for new providers never
  // throws and an obsolete provider id is silently ignored.
  const builtIn = def?.requestFormat ?? 'chat-completions';
  // ADR-047 D2 — an engine (external-agent) provider has no HTTP endpoint and its
  // format is INTRINSIC: a wire-format override cannot turn a subprocess engine
  // into an HTTP call. Resolve it by provider id, before the override + any gating.
  if (builtIn === 'external-agent') return 'external-agent';
  const override = getCliKnobs().providerRequestFormat[providerId];
  const allowedFormat = override ?? builtIn;
  // NATIVE (non-OpenAI-compatible) formats are an explicit opt-in — honor them
  // directly. They carry their own URL/headers/payload (see nativeProviders.ts)
  // and bypass the Responses/Chat gating below entirely.
  if (allowedFormat === 'anthropic-messages' || allowedFormat === 'gemini-generate') return allowedFormat;
  if (allowedFormat !== 'responses') return 'chat-completions';
  const builtInEndpoint = def?.endpoint;
  const endpoint = effectiveEndpoint || config.endpoint || builtInEndpoint || 'https://api.openai.com/v1';
  // When the user EXPLICITLY chose Responses for this provider, trust their
  // endpoint assertion (they are responsible for it accepting /responses). Do
  // NOT gate this by OpenAI-family model names: Responses-capable gateways can
  // route non-OpenAI ids such as `google/gemma-4-12b`.
  if (override === 'responses') return 'responses';
  // Built-in Responses defaults are still provider/model conservative.
  if (!modelSupportsResponsesFormat(config.model)) return 'chat-completions';
  // When falling back to the BUILT-IN default, still require the endpoint
  // to be the canonical one — otherwise `provider:'openai'` + a non-OpenAI
  // endpoint (OpenRouter-shaped, an OpenAI-compatible gateway, ...) gets
  // silently misrouted to /responses and 404s.
  if (override === undefined && builtInEndpoint
      && normalizeProviderEndpoint(endpoint) !== normalizeProviderEndpoint(builtInEndpoint)) {
    return 'chat-completions';
  }
  return 'responses';
}

function normalizeProviderUsage(usage: any): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; [k: string]: unknown } | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  if (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number') return usage;

  const normalized: Record<string, unknown> = { ...usage };
  if (typeof usage.input_tokens === 'number') normalized.prompt_tokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') normalized.completion_tokens = usage.output_tokens;
  if (usage.input_tokens_details && typeof usage.input_tokens_details === 'object') {
    normalized.prompt_tokens_details = usage.input_tokens_details;
  }
  return normalized;
}

function normalizeResponsesOutput(data: any, endpoint: string, model: string) {
  if (data && typeof data === 'object' && data.error) {
    const errMsg = typeof data.error === 'string'
      ? data.error
      : (data.error.message ?? JSON.stringify(data.error).slice(0, 400));
    throw new Error(`LLM endpoint returned an error envelope (HTTP 200): ${errMsg}`);
  }
  if (!Array.isArray(data?.output)) {
    throw new Error(
      `LLM endpoint returned no Responses output. ` +
      `Model "${model}" at ${endpoint} may not support /responses, may need chat/completions, or be misconfigured. ` +
      `Response body: ${JSON.stringify(data).slice(0, 600)}`,
    );
  }

  const textParts: string[] = [];
  const toolCalls: any[] = [];
  for (const item of data.output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') textParts.push(part.text);
        else if (part?.type === 'refusal' && typeof part.refusal === 'string') textParts.push(part.refusal);
        else if (part?.type === 'text' && typeof part.text === 'string') textParts.push(part.text);
      }
      continue;
    }
    if (item?.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id,
        type: 'function',
        function: {
          name: item.name ?? '',
          arguments: typeof item.arguments === 'string' ? item.arguments : stringifyContent(item.arguments ?? {}),
        },
      });
    }
  }

  return {
    content: typeof data.output_text === 'string' && data.output_text.length > 0
      ? data.output_text
      : textParts.join(''),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: normalizeProviderUsage(data.usage),
    finishReason: data.status === 'incomplete'
      ? (data.incomplete_details?.reason ?? 'incomplete')
      : undefined,
  };
}

/**
 * Decide the literal `reasoning_effort` wire value (or null to omit) for the
 * active provider + model. Mechanism + accepted values differ per provider AND
 * per model, so this layers the two axes (provider id → wire mechanism, model
 * name → capability) instead of one global transform:
 *   1. effort unset or the CLI default 'medium' → omit (the prompt overlay is
 *      also empty at medium, so wire + prompt agree).
 *   2. provider's reasoningEffort mode is not 'param' → omit.
 *   3. always-on reasoners (DeepSeek `deepseek-reasoner`) and non-reasoning
 *      `*-chat` variants (OpenAI/gateways ERROR on those) → omit, on EVERY
 *      provider.
 *   4. MODEL gate: 'reasoning-only' providers (OpenAI, which errors on a
 *      non-reasoning model) only send for detected reasoning models; every other
 *      OpenAI-compatible provider defaults to 'any' (accept-and-ignore), so the
 *      field works for reasoning models we have no name pattern for.
 *   5. binary `on`/`off` model metadata is only honored when the provider
 *      explicitly declares that wire vocabulary; otherwise provider rules win
 *      so no endpoint receives invalid `reasoning_effort: "on"`.
 *   6. map the EffortLevel through the provider's effortValueMap (default OpenAI
 *      map: low→low, high→high, xhigh→high). `null` in the map = omit on purpose.
 *   7. model-aware `xhigh`: the default caps xhigh→high, but models that natively
 *      accept `xhigh` (gpt-5.1-codex-max, gpt-5.2+, gpt-5.4/5.5) keep it — don't
 *      silently degrade them. Providers that map xhigh to their own token
 *      (deepseek `max`, opencode `xhigh`) are untouched.
 */
export function resolveWireEffort(config: LLMConfig, effort: EffortLevel | undefined): string | null {
  if (!effort) return null;
  const lvl = effortToWireLevel(effort);
  // The built-in account provider has already validated the selected model
  // against the server catalog. Preserve its exact policy vocabulary, including
  // none/minimal/medium/max, and let the gateway translate upstream.
  if (config.provider === 'brainrouter') return lvl;
  // Preserve existing BYOK semantics: medium means provider default / omitted.
  if (lvl === 'medium') return null;
  const def = activeProviderDef(config);
  if ((def?.reasoningEffort ?? 'param') !== 'param') return null;
  const model = normalizeModelName(config.model);
  if (isAlwaysOnReasoner(model)) return null;       // reasons by default, rejects the field
  if (isNonReasoningChatModel(model)) return null;  // *-chat — OpenAI/gateways error on it
  // OpenAI errors on a non-reasoning model, so it gates by the reasoning-model
  // allowlist; every other OpenAI-compatible provider sends for ANY model (the
  // server ignores it when N/A) so effort works for unlisted reasoning models.
  if ((def?.effortModelGate ?? 'any') === 'reasoning-only' && !isReasoningModel(model)) return null;
  // Binary on/off model (advertises only `on`/`off` via /models): collapse any
  // graded request only when the active provider accepts binary effort literals.
  // Provider rules are authoritative because the capability registry is keyed by
  // model id, while wire vocabularies are provider-specific.
  if (isBinaryReasoningModel(model)) {
    const binaryMap = binaryEffortValueMapFor(def);
    const binaryMapped = binaryMap?.[lvl];
    if (binaryMapped === null) return null;
    if (typeof binaryMapped === 'string' && binaryMapped.trim()) return binaryMapped;
  }
  const map = def?.effortValueMap ?? DEFAULT_EFFORT_VALUE_MAP;
  const mapped = map[lvl];
  if (mapped === null) return null;             // explicit omit for this level
  let wire = mapped ?? (lvl === 'xhigh' ? 'high' : lvl); // undefined → conservative default
  if (lvl === 'xhigh' && wire === 'high' && modelSupportsXhighEffort(model)) {
    wire = 'xhigh';                             // capable model — pass xhigh through, don't degrade
  }
  return wire;
}

/**
 * Fast = minimal reasoning. The LOWEST reasoning level a model supports: graded
 * reasoners dial down to `low` (still reasons, just minimally); non-reasoning,
 * always-on (`deepseek-reasoner`), and binary on/off models collapse to `medium`,
 * which OMITS the reasoning_effort field (off / model default) — see
 * resolveWireEffort. Lets the "Fast" toggle "just go fast" on any model family
 * without the user re-picking an effort. Mirrors the renderer's reasoningProfile.
 */
export function minimalReasoningEffort(model: string | undefined): EffortLevel {
  if (isReasoningModel(model) && !isAlwaysOnReasoner(model) && !isBinaryReasoningModel(model)) {
    return 'low';
  }
  return 'medium';
}

/**
 * Pick the reasoning effort for a turn. Reasoning effort is DECOUPLED from
 * executionMode: it is the user's explicit choice (the composer's model-aware
 * reasoning slider), independent of Fast mode. Fast mode now only affects the
 * agentic strategy (direct answers / minimal planning), not how hard the model
 * thinks. A per-run override (a spawned child's fixed effort) still wins.
 * `minimalReasoningEffort` is retained (and unit-tested) for callers that want
 * to dial a model to its floor explicitly. Pure + isolated.
 */
export function effortForTurnSelection(
  mode: { effort: EffortLevel; executionMode?: string },
  _model: string | undefined,
  override: EffortLevel | undefined,
): EffortLevel {
  if (override) return override;
  return mode.effort;
}

export interface BuildPayloadOptions {
  /** Reasoning-depth preference, when provider supports it. `medium` is a no-op. */
  effort?: EffortLevel;
  /** DESK-6 — abort the in-flight request the instant the user presses Stop. */
  signal?: AbortSignal;
  /**
   * Tool-choice override. Default (when `tools` are present) is `'auto'`; pass a
   * specific function to FORCE structured output (the model must call it), e.g.
   * `{ type: 'function', function: { name: 'emit_layers' } }`.
   */
  tool_choice?: 'auto' | { type: 'function'; function: { name: string } };
  /**
   * Optional hard ceiling for the complete provider response body. The body is
   * rejected while it is being read, before an unbounded JSON string/object is
   * allocated. Intended for one-shot classifiers and other bounded adapters.
   */
  maxResponseBytes?: number;
  /** Disable compatibility retries when the caller's contract permits one request only. */
  allowCompatibilityRetry?: boolean;
  /**
   * Invoked immediately before each physical provider request, including
   * compatibility retries. A caller may throw here to enforce an aggregate
   * request ceiling without changing transport behavior for other callers.
   */
  beforeProviderRequest?: () => void;
  /**
   * Router gateway — verbatim OpenAI request params to forward to the upstream
   * (temperature, top_p, max_tokens/max_completion_tokens, stop,
   * presence/frequency_penalty, seed, response_format, n, logprobs,
   * top_logprobs, logit_bias, user, parallel_tool_calls, stream_options,
   * service_tier, prediction, metadata, modalities). The agent never sets this;
   * only the OpenAI-compatible gateway does, so its clients' sampling params
   * reach the provider. Whitelisted in buildChatCompletionPayload — never
   * overrides model/messages/tools/tool_choice.
   */
  passthrough?: Record<string, unknown>;
}

const MIN_BOUNDED_RESPONSE_BYTES = 1;
const MAX_BOUNDED_RESPONSE_BYTES = 16 * 1024 * 1024;

function assertValidResponseByteLimit(maxBytes: number | undefined): void {
  if (maxBytes === undefined) return;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_BOUNDED_RESPONSE_BYTES ||
      maxBytes > MAX_BOUNDED_RESPONSE_BYTES) {
    throw new Error('Invalid LLM response byte limit.');
  }
}

async function readResponseText(response: Response, maxBytes?: number): Promise<string> {
  if (maxBytes === undefined) return response.text();
  assertValidResponseByteLimit(maxBytes);

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`LLM response exceeded the ${maxBytes}-byte limit.`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`LLM response exceeded the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

async function readResponseJson(response: Response, maxBytes?: number): Promise<any> {
  if (maxBytes === undefined) return response.json() as Promise<any>;
  const text = await readResponseText(response, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('LLM endpoint returned invalid JSON.');
  }
}

/** OpenAI chat params the gateway may forward verbatim (never model/messages/tools). */
export const GATEWAY_PASSTHROUGH_PARAMS = [
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'n',
  'presence_penalty', 'frequency_penalty', 'seed', 'response_format', 'logprobs',
  'top_logprobs', 'logit_bias', 'user', 'parallel_tool_calls', 'stream_options',
  'service_tier', 'prediction', 'metadata', 'modalities', 'store',
] as const;

function stripTaggedContent(content: any): any {
  return typeof content === 'string' && TAG_MARKER_RE.test(content)
    ? content.replace(TAG_MARKER_RE, '')
    : content;
}

function stringifyContent(content: any): string {
  const stripped = stripTaggedContent(content);
  if (typeof stripped === 'string') return stripped;
  try {
    return JSON.stringify(stripped);
  } catch {
    return String(stripped ?? '');
  }
}

function hasPromptLayers(message: any): message is PromptLayeredMessage & { promptLayers: PromptLayers } {
  return (
    !!message &&
    message.role === 'system' &&
    message.promptLayers &&
    typeof message.promptLayers.instructions === 'string' &&
    Array.isArray(message.promptLayers.developer) &&
    typeof message.promptLayers.environment === 'string'
  );
}

export function appendDeveloperPromptLayer(message: any, content: string): boolean {
  if (!hasPromptLayers(message)) return false;
  const rendered = content.trim();
  if (!rendered) return true;
  message.content = [stringifyContent(message.content), rendered].filter(Boolean).join('\n\n');
  message.promptLayers = {
    ...message.promptLayers,
    developer: [...message.promptLayers.developer, rendered],
  };
  return true;
}

function promptLayerInputParts(layers: PromptLayers): Array<{ type: 'input_text'; text: string }> {
  return [layers.instructions, ...layers.developer]
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ type: 'input_text' as const, text }));
}

function promptLayerSystemContent(layers: PromptLayers): string {
  return promptLayerInputParts(layers).map((part) => part.text).join('\n\n');
}

function expandPromptLayersForChatCompletions(messages: any[]): any[] {
  const first = messages[0];
  const systemParts: string[] = [];
  const out: any[] = [];
  let rest = messages;

  if (hasPromptLayers(first)) {
    const systemContent = [
      promptLayerSystemContent(first.promptLayers),
      first.promptLayers.environment.trim(),
    ].filter(Boolean).join('\n\n');
    if (systemContent) systemParts.push(systemContent);
    rest = messages.slice(1);
  } else if (first?.role === 'system' || first?.role === 'developer') {
    const systemContent = stringifyContent(first.content).trim();
    if (systemContent) systemParts.push(systemContent);
    rest = messages.slice(1);
  }

  for (const message of rest) {
    if (message?.role === 'system' || message?.role === 'developer') {
      const systemContent = stringifyContent(message.content).trim();
      if (systemContent) systemParts.push(systemContent);
      continue;
    }
    out.push(message);
  }

  if (systemParts.length > 0) {
    out.unshift({ role: 'system', content: systemParts.join('\n\n') });
  }
  return out;
}

function mapChatCompletionMessage(m: any): any {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.tool_call_id,
      name: m.name,
      content: stringifyContent(m.content),
    };
  }
  if (m.role === 'assistant') {
    const out: any = { role: 'assistant', content: m.content || null };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    return out;
  }
  if (m.role === 'developer') {
    return {
      role: 'system',
      content: stripTaggedContent(m.content),
    };
  }
  const text = stripTaggedContent(m.content);
  // vision — a user message carrying pasted images becomes MULTI-PART content
  // (OpenAI `image_url` data-URLs). OpenAI-compatible endpoints read these
  // directly; the native Anthropic/Gemini adapters translate the image_url
  // parts into their own image blocks. Non-vision endpoints ignore them.
  if (Array.isArray(m.images) && m.images.length > 0) {
    const parts: any[] = [];
    if (text) parts.push({ type: 'text', text });
    for (const img of m.images) {
      if (img?.dataBase64 && img?.mediaType) {
        parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` } });
      }
    }
    if (parts.length > 0) return { role: m.role, content: parts };
  }
  return {
    role: m.role,
    content: text,
  };
}

function inputTextContent(text: string): Array<{ type: 'input_text'; text: string }> {
  return [{ type: 'input_text', text }];
}

function outputTextContent(text: string): Array<{ type: 'output_text'; text: string }> {
  return [{ type: 'output_text', text }];
}

function buildResponsesInput(messages: any[]): { instructions?: string; input: any[] } {
  const first = messages[0];
  const input: any[] = [];
  let instructions: string | undefined;
  let rest = messages;

  if (hasPromptLayers(first)) {
    instructions = first.promptLayers.instructions.trim() || undefined;
    const content = first.promptLayers.developer
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ type: 'input_text' as const, text }));
    if (content.length > 0) {
      input.push({
        type: 'message',
        role: 'developer',
        content,
      });
    }
    if (first.promptLayers.environment.trim()) {
      input.push({
        type: 'message',
        role: 'user',
        content: inputTextContent(first.promptLayers.environment),
      });
    }
    rest = messages.slice(1);
  } else if (first?.role === 'system' || first?.role === 'developer') {
    instructions = stringifyContent(first.content).trim() || undefined;
    rest = messages.slice(1);
  }

  for (const message of rest) {
    const role = message?.role;
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id ?? message.name ?? ''),
        output: stringifyContent(message.content),
      });
      continue;
    }

    if (role === 'assistant') {
      const content = typeof message.content === 'string' ? message.content : '';
      if (content.trim()) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: outputTextContent(content),
        });
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          const fn = call?.function ?? {};
          input.push({
            type: 'function_call',
            call_id: String(call?.id ?? ''),
            name: String(fn.name ?? ''),
            arguments: typeof fn.arguments === 'string' ? fn.arguments : stringifyContent(fn.arguments ?? {}),
          });
        }
      }
      continue;
    }

    if (role === 'system' || role === 'developer') {
      input.push({
        type: 'message',
        role: 'developer',
        content: inputTextContent(stringifyContent(message.content)),
      });
      continue;
    }

    if (role === 'user') {
      const content: any[] = inputTextContent(stringifyContent(message.content));
      // vision — the Responses API takes images as `input_image` parts (data-URL).
      if (Array.isArray(message.images)) {
        for (const img of message.images) {
          if (img?.dataBase64 && img?.mediaType) {
            content.push({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.dataBase64}` });
          }
        }
      }
      input.push({ type: 'message', role, content });
    }
  }

  return { instructions, input };
}

function buildChatToolSpecs(tools: any[]): NonNullable<ChatCompletionPayload['tools']> {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

function buildResponsesToolSpecs(tools: any[]): NonNullable<ResponsesPayload['tools']> {
  return tools.map(t => ({
    type: 'function',
    name: t.name,
    description: t.description || '',
    parameters: t.inputSchema || { type: 'object', properties: {} },
    strict: false,
  }));
}

export function buildChatCompletionPayload(
  config: LLMConfig,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions = {},
): ChatCompletionPayload {
  const mappedMessages = expandPromptLayersForChatCompletions(messages).map(mapChatCompletionMessage);

  const body: ChatCompletionPayload = {
    model: config.model,
    messages: mappedMessages,
  };

  if (tools.length > 0) {
    body.tools = buildChatToolSpecs(tools);
    // Default 'auto'; callers can force a specific function (structured output).
    body.tool_choice = options.tool_choice ?? 'auto';
  }

  // Forward reasoning_effort PROVIDER-AWARELY (see resolveWireEffort): only for
  // reasoning models on providers that accept the field, mapping the CLI level to
  // the provider's accepted wire value (e.g. opencode keeps `xhigh`, DeepSeek-v4
  // maps it to `max`, OpenAI/Ollama downgrade to `high`). `medium` is the CLI
  // default and is always omitted. The wire SHAPE is provider-specific too: most
  // take the flat `reasoning_effort`; LM Studio documents the nested
  // `reasoning: { effort }` form, so we honour `effortField` ('both' sends both).
  const wireEffort = resolveWireEffort(config, options.effort);
  if (wireEffort !== null) {
    const shape = activeProviderDef(config)?.effortField ?? 'flat';
    if (shape === 'flat' || shape === 'both') body.reasoning_effort = wireEffort;
    if (shape === 'nested' || shape === 'both') body.reasoning = { effort: wireEffort };
  }

  // Cut-off fix — BrainRouter normally sends NO max_tokens (the provider uses
  // its own default, which on some endpoints — e.g. certain fast/cheap models —
  // is a low completion cap that truncates long answers mid-sentence). When the
  // user sets `cli.maxOutputTokens`, forward it so they can lift that cap.
  const maxOutput = getCliKnobs().maxOutputTokens;
  if (typeof maxOutput === 'number' && maxOutput > 0) {
    (body as ChatCompletionPayload & { max_tokens?: number }).max_tokens = Math.floor(maxOutput);
  }

  // Router gateway — forward whitelisted OpenAI sampling params from the client
  // verbatim (never model/messages/tools). Applied last so a client's explicit
  // max_tokens wins over the cli.maxOutputTokens default above.
  if (options.passthrough && typeof options.passthrough === 'object') {
    const extra = body as unknown as Record<string, unknown>;
    for (const key of GATEWAY_PASSTHROUGH_PARAMS) {
      const value = (options.passthrough as Record<string, unknown>)[key];
      if (value !== undefined) extra[key] = value;
    }
  }

  return body;
}

export function buildResponsesPayload(
  config: LLMConfig,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions = {},
): ResponsesPayload {
  const { instructions, input } = buildResponsesInput(messages);
  const body: ResponsesPayload = {
    model: config.model,
    input,
    store: false,
    include: [],
  };
  if (instructions) body.instructions = instructions;

  if (tools.length > 0) {
    body.tools = buildResponsesToolSpecs(tools);
    const choice = options.tool_choice ?? 'auto';
    body.tool_choice = choice === 'auto'
      ? 'auto'
      : { type: 'function', name: choice.function.name };
    body.parallel_tool_calls = true;
  }

  const wireEffort = resolveWireEffort(config, options.effort);
  if (wireEffort !== null) {
    body.reasoning = { effort: wireEffort };
  }

  const maxOutput = getCliKnobs().maxOutputTokens;
  if (typeof maxOutput === 'number' && maxOutput > 0) {
    body.max_output_tokens = Math.floor(maxOutput);
  }

  return body;
}

function stripReasoningEffortFromBody(body: any): any | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const hasFlat = Object.prototype.hasOwnProperty.call(body, 'reasoning_effort');
  const hasNested = body.reasoning &&
    typeof body.reasoning === 'object' &&
    Object.prototype.hasOwnProperty.call(body.reasoning, 'effort');
  if (!hasFlat && !hasNested) return undefined;

  const next = { ...body };
  delete next.reasoning_effort;
  if (hasNested) {
    const reasoning = { ...next.reasoning };
    delete reasoning.effort;
    if (Object.keys(reasoning).length > 0) next.reasoning = reasoning;
    else delete next.reasoning;
  }
  return next;
}

function isInvalidReasoningEffortError(status: number, body: string): boolean {
  if (status !== 400) return false;
  return /(reasoning[_\-. ]?effort|reasoning\.effort)/i.test(body) &&
    /(invalid|unsupported|not supported|supported values|possible values|unknown|unrecognized)/i.test(body);
}

/**
 * HONK-L4 — drop `tools`/`tool_choice` for the retry. Returns a cloned body
 * without them, or `undefined` when the body never carried tools (so the caller
 * skips the retry). This is the "must replicate the drop-and-retry" safety net:
 * some local/OSS endpoints (and a few OpenAI-compatible gateways) 400 on tools or
 * a forced `tool_choice` they don't implement; rather than hard-fail the turn we
 * resend without them and let the model answer in plain content.
 */
export function stripToolsFromBody(body: any): any | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const hasTools = Object.prototype.hasOwnProperty.call(body, 'tools') && Array.isArray(body.tools) && body.tools.length > 0;
  const hasChoice = Object.prototype.hasOwnProperty.call(body, 'tool_choice');
  if (!hasTools && !hasChoice) return undefined;
  const next = { ...body };
  delete next.tools;
  delete next.tool_choice;
  // Responses-format payloads carry tools under the same keys; covered above.
  return next;
}

/** A 400/404/422 whose body blames `tools` / `tool_choice` / `function` support. */
export function isToolsUnsupportedError(status: number, body: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /(tool_choice|tool[_\-. ]?call|\btools\b|function[_\-. ]?call|functions?)/i.test(body) &&
    /(invalid|unsupported|not supported|no(t)? (support|implement)|unknown|unrecognized|does not support|cannot|unexpected|not allowed|unavailable)/i.test(body);
}

/**
 * DESK-6 — sentinel thrown when an in-flight LLM call is aborted because the
 * USER pressed Stop (not a timeout / connectivity blip). The resilient loop
 * must NOT reconnect on this (a Stop is deliberate), and the turn unwinds with
 * the clean "interrupted" answer. Kept distinct from the timeout error, whose
 * message intentionally matches CONNECTIVITY_RE so genuine timeouts still retry.
 */
export class InterruptError extends Error {
  readonly isInterrupt = true;
  constructor(message = 'Interrupted by user') { super(message); this.name = 'InterruptError'; }
}
export function isInterrupt(err: any): boolean {
  return !!err && (err.name === 'InterruptError' || err.isInterrupt === true);
}
/** A delay that resolves early (no throw) the instant `signal` aborts. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Translate the agent's internal messages/tools into the input a native
 * (non-OpenAI) provider builder expects. Reuses the SAME proven normalization
 * the chat-completions path uses (`expandPromptLayersForChatCompletions` +
 * `mapChatCompletionMessage`), then peels the leading system message off as the
 * provider `system` text. Keeping this here means `nativeProviders.ts` only ever
 * sees OpenAI-clean messages and stays a pure shape-translator.
 */
function buildNativeInput(
  format: NativeRequestFormat,
  config: LLMConfig,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions,
): NativeBuildInput {
  const mapped = expandPromptLayersForChatCompletions(messages).map(mapChatCompletionMessage);
  let system = '';
  let rest = mapped;
  if (mapped[0]?.role === 'system') {
    system = String(mapped[0].content ?? '');
    rest = mapped.slice(1);
  }
  const maxOutput = getCliKnobs().maxOutputTokens;
  const userMax = typeof maxOutput === 'number' && maxOutput > 0 ? Math.floor(maxOutput) : undefined;
  // Anthropic REQUIRES max_tokens; fall back to the conservative default. Gemini
  // has its own server default, so only forward an explicit user cap.
  const maxTokens = format === 'anthropic-messages' ? (userMax ?? ANTHROPIC_DEFAULT_MAX_TOKENS) : userMax;
  return {
    model: config.model,
    system,
    messages: rest,
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    toolChoice: options.tool_choice,
    maxTokens,
  };
}

/**
 * Issue ONE native-format LLM call (Anthropic Messages / Gemini generateContent)
 * and return the same `{ content, toolCalls?, usage?, finishReason? }` shape as
 * `callOpenAI`. Mirrors `callOpenAI`'s timeout / abort / semaphore / Retry-After
 * handling so the resilient loop classifies failures identically. The OpenAI and
 * Responses paths are untouched — this only runs when a provider is opted into a
 * native format via `cli.providerRequestFormat`.
 */
async function callNativeProvider(
  format: NativeRequestFormat,
  config: LLMConfig,
  endpoint: string,
  apiKey: string,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions,
): Promise<NativeOutput> {
  const buildInput = buildNativeInput(format, config, messages, tools, options);
  const body = format === 'anthropic-messages'
    ? buildAnthropicMessagesPayload(buildInput)
    : buildGeminiGeneratePayload(buildInput);
  const { url, headers } = nativeRequestSpec(format, endpoint, config.model, apiKey);

  const prefixFingerprint = computePrefixFingerprint(messages, tools);
  traceEvent('llm_call.prefix_fingerprint', {
    model: config.model,
    endpoint,
    requestFormat: format,
    prefixFingerprint,
    promptMessages: buildInput.messages.length,
    toolCount: tools.length,
  });

  const timeoutMs = getCliKnobs().llmTimeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const release = await acquireLLMSlot();
  let res: Response;
  try {
    options.beforeProviderRequest?.();
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: fetchSignal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      if (options.signal?.aborted) throw new InterruptError();
      throw new Error(`LLM request timed out after ${timeoutMs}ms. Check that ${endpoint} answers ${format} requests for model "${config.model}".`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    release();
  }

  if (!res.ok) {
    const errText = await readResponseText(res, options.maxResponseBytes);
    const apiErr: any = new Error(`${format} API error: ${res.status} ${res.statusText} - ${errText}`);
    apiErr.status = res.status;
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    if (retryAfterMs !== undefined) apiErr.retryAfterMs = retryAfterMs;
    throw apiErr;
  }

  const data = await readResponseJson(res, options.maxResponseBytes);
  return format === 'anthropic-messages'
    ? normalizeAnthropicOutput(data, endpoint, config.model)
    : normalizeGeminiOutput(data, endpoint, config.model);
}

/** Read a Response body as an async iterable of decoded text chunks (for SSE). */
async function* readResponseTextChunks(res: Response): AsyncIterable<string> {
  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
  } finally {
    try { reader.releaseLock?.(); } catch { /* already released */ }
  }
}

/**
 * ADR-041 A41-5 — the streaming native call. Same request as `callNativeProvider`,
 * but asks for SSE (Anthropic: `stream: true`; Gemini: the `:streamGenerateContent`
 * surface with `alt=sse`) and feeds the body to the provider-native parser, which
 * emits deltas live and returns the same `NativeOutput` shape as the whole-response
 * path. It throws on a setup/HTTP failure so the caller can fall back before any
 * delta has been emitted.
 */
async function callNativeProviderStream(
  format: NativeRequestFormat,
  config: LLMConfig,
  endpoint: string,
  apiKey: string,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions,
  handlers: NativeStreamHandlers,
): Promise<NativeOutput> {
  const buildInput = buildNativeInput(format, config, messages, tools, options);
  const spec = nativeRequestSpec(format, endpoint, config.model, apiKey);
  let url = spec.url;
  let body: any;
  if (format === 'anthropic-messages') {
    body = buildAnthropicMessagesPayload(buildInput);
    body.stream = true;
  } else {
    body = buildGeminiGeneratePayload(buildInput);
    // Gemini streams from a distinct method + SSE framing, not a body flag.
    url = spec.url.replace(':generateContent', ':streamGenerateContent?alt=sse');
  }

  const prefixFingerprint = computePrefixFingerprint(messages, tools);
  traceEvent('llm_call.prefix_fingerprint', {
    model: config.model,
    endpoint,
    requestFormat: format,
    prefixFingerprint,
    promptMessages: buildInput.messages.length,
    toolCount: tools.length,
    stream: true,
  });

  const timeoutMs = getCliKnobs().llmTimeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const release = await acquireLLMSlot();
  let res: Response;
  try {
    options.beforeProviderRequest?.();
    res = await fetch(url, { method: 'POST', headers: spec.headers, body: JSON.stringify(body), signal: fetchSignal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      if (options.signal?.aborted) throw new InterruptError();
      throw new Error(`LLM stream request timed out after ${timeoutMs}ms. Check that ${endpoint} answers ${format} requests for model "${config.model}".`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    release();
  }

  if (!res.ok || !res.body) {
    const errText = res.body ? await readResponseText(res, options.maxResponseBytes) : '';
    const apiErr: any = new Error(`${format} stream API error: ${res.status} ${res.statusText} - ${errText}`);
    apiErr.status = res.status;
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    if (retryAfterMs !== undefined) apiErr.retryAfterMs = retryAfterMs;
    throw apiErr;
  }

  const parse = format === 'anthropic-messages' ? parseAnthropicMessageStream : parseGeminiStream;
  try {
    return await parse(readResponseTextChunks(res), handlers, endpoint, config.model);
  } catch (err: any) {
    // After the 200 the timeout is cleared, so the only signal that can abort the
    // body read is the user's Stop — which rejects reader.read() with a raw
    // AbortError. Map it to InterruptError so the caller PROPAGATES the Stop
    // instead of mistaking it for a stream failure and issuing a second call.
    // (Mirrors the OpenAI-compat path's mid-stream abort guard.)
    if (err instanceof InterruptError) throw err;
    if (err?.name === 'AbortError' && options.signal?.aborted) throw new InterruptError();
    throw err;
  }
}

export async function callOpenAI(
  config: LLMConfig,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions = {},
) {
  // Reject malformed or effectively unbounded opt-in limits before contacting
  // a provider. Callers that need the legacy unrestricted behavior omit it.
  assertValidResponseByteLimit(options.maxResponseBytes);
  // ADR-047 D2 — engine mode: an installed coding-agent CLI drives this turn.
  // Resolved purely by provider id (no endpoint, no API key), so short-circuit
  // BEFORE the endpoint normalization + key guard below. Everything past this
  // point is byte-identical to before for every HTTP provider.
  if (resolveRequestFormat(config) === 'external-agent') {
    return callExternalAgentEngine(config, messages, { signal: options.signal });
  }
  // Normalize the endpoint to a base URL (everything UP TO `/chat/completions`
  // exclusive). Earlier callers stored the full chat-completions URL in
  // `config.endpoint` (e.g. "https://api.openai.com/v1/chat/completions")
  // because the in-terminal wizard's provider catalog wrote the full path.
  // We then re-append `/chat/completions` below, producing a duplicate
  // `/chat/completions/chat/completions` and a 404. Strip the suffix
  // defensively so both shapes (full URL or base URL) work.
  const initialDef = activeProviderDef(config);
  const rawEndpoint = config.endpoint || initialDef?.endpoint || 'https://api.openai.com/v1';
  const endpoint = stripTrailingSlashes(rawEndpoint).replace(/\/chat\/completions$/, '');
  const effectiveConfig: LLMConfig = { ...config, endpoint };
  // Key resolution is CONFIG-DRIVEN, not env-driven: BrainRouter reads the key
  // from config.apiKey (the config knob). Standard provider env vars are imported
  // into config ONCE at load time (config.ts → backfillApiKeyFromEnv), so we never
  // re-read process.env here — that also stops an OPENAI_API_KEY present in the
  // shell from being sent as a Bearer to a NON-OpenAI endpoint. A provider with a
  // public/anonymous tier (opencode "public") supplies a last-resort key; a local
  // server accepts a throwaway bearer. Locality comes from the provider's `local`
  // flag first, then a loopback-endpoint check (covers a custom local gateway).
  const def = activeProviderDef(effectiveConfig);
  let apiKey = config.apiKey || '';
  const isLocal = (def?.local ?? false) || isLoopbackEndpoint(endpoint);
  if (!apiKey && !isLocal && def?.defaultApiKey) apiKey = def.defaultApiKey;
  if (!apiKey && !isLocal) {
    throw new Error('LLM API key is required — set it in your BrainRouter config (the key is read from config, not the environment).');
  }
  if (!apiKey && isLocal) {
    apiKey = LOCAL_PLACEHOLDER_KEY;
  }

  const requestFormat = resolveRequestFormat(effectiveConfig, endpoint);
  // NATIVE formats carry their own URL/headers/payload — hand off and return.
  if (requestFormat === 'anthropic-messages' || requestFormat === 'gemini-generate') {
    return callNativeProvider(requestFormat, effectiveConfig, endpoint, apiKey, messages, tools, options);
  }
  const body = requestFormat === 'responses'
    ? buildResponsesPayload(effectiveConfig, messages, tools, options)
    : buildChatCompletionPayload(effectiveConfig, messages, tools, options);

  // 0.3.9 item 8 — emit the cache-stable prefix fingerprint for this
  // request. When tracing is disabled this resolves to a no-op
  // (traceEvent short-circuits on missing BRAINROUTER_TRACE_LOG). When
  // it's on, downstream items can correlate the fingerprint against
  // the provider's cache_hit telemetry (item 10) to confirm the prefix
  // is staying byte-stable across turns.
  const prefixFingerprint = computePrefixFingerprint(messages, tools);
  traceEvent('llm_call.prefix_fingerprint', {
    model: config.model,
    endpoint,
    requestFormat,
    prefixFingerprint,
    promptMessages: requestFormat === 'responses' ? (body as ResponsesPayload).input.length : (body as ChatCompletionPayload).messages.length,
    toolCount: body.tools?.length ?? 0,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const requestUrl = withApiVersion(`${endpoint}/${requestFormat === 'responses' ? 'responses' : 'chat/completions'}`, config.apiVersion);
  const postBody = async (requestBody: any): Promise<Response> => {
    const timeoutMs = getCliKnobs().llmTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // DESK-6 — abort on EITHER the timeout OR the user's Stop signal; the catch
    // disambiguates so a Stop never masquerades as a (retryable) timeout.
    const fetchSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

    // Gate every chat LLM call through the process-wide semaphore. This
    // prevents a fan-out of N parallel children from firing N simultaneous
    // requests at the backend — the same condition that was unloading the
    // local LM Studio model. The MCP child has its own matching semaphore;
    // both consume the BRAINROUTER_LLM_MAX_CONCURRENT budget on the same
    // backend instance.
    const release = await acquireLLMSlot();
    try {
      options.beforeProviderRequest?.();
      return await fetch(requestUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: fetchSignal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        if (options.signal?.aborted) throw new InterruptError();
        throw new Error(`LLM request timed out after ${timeoutMs}ms. Check that ${endpoint} is running and that model "${config.model}" can answer ${requestFormat} requests with tools enabled.`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      // Release once the headers are back; reading the body is local work that
      // doesn't need to block other LLM callers from starting.
      release();
    }
  };

  let res = await postBody(body);
  if (!res.ok) {
    const errText = await readResponseText(res, options.maxResponseBytes);
    const compatibilityRetriesEnabled = options.allowCompatibilityRetry !== false;
    let retryBody = compatibilityRetriesEnabled && isInvalidReasoningEffortError(res.status, errText)
      ? stripReasoningEffortFromBody(body)
      : undefined;
    let retryKind = retryBody ? 'reasoning_effort' : '';
    // HONK-L4 — if the endpoint rejected tools/tool_choice, drop them and retry
    // (degrade to a plain-content answer) instead of hard-failing the turn.
    if (compatibilityRetriesEnabled && !retryBody && isToolsUnsupportedError(res.status, errText)) {
      retryBody = stripToolsFromBody(body);
      if (retryBody) retryKind = 'tools_unsupported';
    }
    // A 400 whose body does NOT name the offending field — an OpenAI-compatible
    // proxy masking the upstream rejection as "Upstream request failed" / a generic
    // invalid_request_error. A common cause is a free / OSS model that silently
    // rejects `reasoning_effort`. If we sent it, strip it and retry ONCE before
    // giving up, rather than hard-failing the turn. (stripReasoningEffortFromBody
    // returns undefined when there was nothing to strip, so this is a no-op then.)
    if (compatibilityRetriesEnabled && !retryBody && res.status === 400) {
      const stripped = stripReasoningEffortFromBody(body);
      if (stripped) { retryBody = stripped; retryKind = 'reasoning_effort'; }
    }
    if (retryBody) {
      traceEvent(retryKind === 'tools_unsupported' ? 'llm_call.tools_unsupported_retry' : 'llm_call.reasoning_effort_retry', {
        model: config.model,
        endpoint,
        requestFormat,
        status: res.status,
      });
      res = await postBody(retryBody);
      if (res.ok) {
        const retryData = await readResponseJson(res, options.maxResponseBytes);
        if (requestFormat === 'responses') {
          return normalizeResponsesOutput(retryData, endpoint, config.model);
        }
        return normalizeChatCompletionOutput(retryData, endpoint, config.model);
      }
    }
    // RECONNECT — attach the structured status + any `Retry-After` so the resilient
    // loop classifies it (429/5xx → reconnect) and honors the server's backoff.
    const finalErrText = retryBody ? await readResponseText(res, options.maxResponseBytes) : errText;
    const apiErr: any = new Error(`OpenAI API error: ${res.status} ${res.statusText} - ${finalErrText}`);
    apiErr.status = res.status;
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    if (retryAfterMs !== undefined) apiErr.retryAfterMs = retryAfterMs;
    throw apiErr;
  }

  const data = await readResponseJson(res, options.maxResponseBytes);
  if (requestFormat === 'responses') {
    return normalizeResponsesOutput(data, endpoint, config.model);
  }

  return normalizeChatCompletionOutput(data, endpoint, config.model);
}

function normalizeChatCompletionOutput(data: any, endpoint: string, model: string) {
  // Defensive response-shape parsing. Some endpoints (LM Studio with certain
  // models, OpenRouter on specific upstream errors, local vLLM under load,
  // gpt-oss reasoning models with a non-standard envelope) return a 200 OK
  // with NO `choices` array — they smuggle the failure into the body as
  // `{error: ...}` or change the schema entirely. Unguarded `data.choices[0]`
  // then crashes with "Cannot read properties of undefined" and the user
  // has no idea what the upstream actually sent. Surface the body in the
  // error so they can spot the actual problem (wrong model name, OOM,
  // content-filter refusal, etc.).
  if (data && typeof data === 'object' && data.error) {
    const errMsg = typeof data.error === 'string'
      ? data.error
      : (data.error.message ?? JSON.stringify(data.error).slice(0, 400));
    throw new Error(`LLM endpoint returned an error envelope (HTTP 200): ${errMsg}`);
  }
  if (!Array.isArray(data?.choices) || data.choices.length === 0) {
    throw new Error(
      `LLM endpoint returned no choices. ` +
      `Model "${model}" at ${endpoint} may not support chat/completions, ` +
      `may need a different request shape (reasoning/harmony format?), or be misconfigured. ` +
      `Response body: ${JSON.stringify(data).slice(0, 600)}`,
    );
  }
  const choice = data.choices[0];
  if (!choice?.message) {
    // Streaming-style frames have `delta` instead of `message` — accept both
    // so a partially-misconfigured endpoint at least surfaces what it sent.
    const delta = choice?.delta;
    if (delta && typeof delta === 'object') {
      return {
        content: delta.content || '',
        toolCalls: delta.tool_calls,
        usage: data.usage,
        finishReason: choice?.finish_reason,
      };
    }
    throw new Error(`OpenAI-compatible endpoint returned an invalid chat completion response: ${JSON.stringify(data).slice(0, 1000)}`);
  }
  return {
    // Some reasoning models put the visible answer in `message.content` and
    // chain-of-thought in `message.reasoning_content` / `reasoning`. We use
    // content (the canonical user-visible field) but tolerate it being null
    // when there are tool_calls but no prose.
    content: choice.message.content ?? '',
    toolCalls: choice.message.tool_calls,
    usage: data.usage,
    // `length` ⇒ the provider truncated the reply at its token cap (the cut-off
    // symptom). Surfaced as a notice → "raise cli.maxOutputTokens".
    finishReason: choice.finish_reason,
  };
}

/**
 * Streaming variant of `callOpenAI`. Returns the same shape after the
 * stream completes, but invokes `handlers.onTextDelta` / `onReasoningDelta`
 * as SSE frames arrive so the UI can paint live.
 *
 * Supports OpenAI-flavored SSE: lines starting with `data: ` followed by
 * either `[DONE]` or a JSON frame `{ choices: [{ delta: {...} }], ... }`.
 * Tool-call deltas accumulate by `index` (the standard OpenAI shape) so
 * we end with a fully-assembled `tool_calls` array compatible with the
 * existing non-streaming code path.
 *
 * Falls back to throwing on non-SSE bodies — callers must wrap in
 * try/catch and retry with the non-streaming `callOpenAI` if needed.
 */
export async function callOpenAIStream(
  config: LLMConfig,
  messages: any[],
  tools: any[],
  options: BuildPayloadOptions = {},
  handlers: {
    onTextDelta?: (text: string) => void;
    onReasoningDelta?: (text: string) => void;
  } = {},
) {
  // ADR-047 D2 — engine mode (see callOpenAI). An engine turn is not an SSE
  // stream; run it and emit the whole answer as ONE text delta so the streaming
  // consumer paints it, then return the same terminal shape.
  if (resolveRequestFormat(config) === 'external-agent') {
    return callExternalAgentEngine(config, messages, { signal: options.signal, onTextDelta: handlers.onTextDelta });
  }
  const initialDef = activeProviderDef(config);
  const rawEndpoint = config.endpoint || initialDef?.endpoint || 'https://api.openai.com/v1';
  const endpoint = stripTrailingSlashes(rawEndpoint).replace(/\/chat\/completions$/, '');
  const effectiveConfig: LLMConfig = { ...config, endpoint };
  // Key resolution is CONFIG-DRIVEN, not env-driven: BrainRouter reads the key
  // from config.apiKey (the config knob). Standard provider env vars are imported
  // into config ONCE at load time (config.ts → backfillApiKeyFromEnv), so we never
  // re-read process.env here — that also stops an OPENAI_API_KEY present in the
  // shell from being sent as a Bearer to a NON-OpenAI endpoint. A provider with a
  // public/anonymous tier (opencode "public") supplies a last-resort key; a local
  // server accepts a throwaway bearer. Locality comes from the provider's `local`
  // flag first, then a loopback-endpoint check (covers a custom local gateway).
  const def = activeProviderDef(effectiveConfig);
  let apiKey = config.apiKey || '';
  const isLocal = (def?.local ?? false) || isLoopbackEndpoint(endpoint);
  if (!apiKey && !isLocal && def?.defaultApiKey) apiKey = def.defaultApiKey;
  if (!apiKey && !isLocal) {
    throw new Error('LLM API key is required — set it in your BrainRouter config (the key is read from config, not the environment).');
  }
  if (!apiKey && isLocal) {
    apiKey = LOCAL_PLACEHOLDER_KEY;
  }

  const requestFormat = resolveRequestFormat(effectiveConfig, endpoint);
  // ADR-041 A41-5 — NATIVE formats stream their own SSE. Emit deltas live; if the
  // stream fails before anything was PAINTED (no text/reasoning delta yet — a
  // setup/HTTP error or a parser fault, or a network drop on a tool-only stream),
  // degrade to the proven non-streaming path so an opt-in native adapter never
  // regresses below today's behavior. Once text/reasoning has painted, a failure
  // surfaces instead — re-running non-streaming would double-paint. A user Stop is
  // an InterruptError (mapped in callNativeProviderStream) and always propagates,
  // never a fallback that would fire a second call on a cancelled turn.
  if (requestFormat === 'anthropic-messages' || requestFormat === 'gemini-generate') {
    let paintedAny = false;
    const streamHandlers: NativeStreamHandlers = {
      onTextDelta: (t) => { paintedAny = true; handlers.onTextDelta?.(t); },
      onReasoningDelta: (t) => { paintedAny = true; handlers.onReasoningDelta?.(t); },
    };
    try {
      return await callNativeProviderStream(requestFormat, effectiveConfig, endpoint, apiKey, messages, tools, options, streamHandlers);
    } catch (err) {
      if (err instanceof InterruptError) throw err;
      if ((err as any)?.name === 'AbortError' && options.signal?.aborted) throw new InterruptError();
      if (paintedAny) throw err;
      const result = await callNativeProvider(requestFormat, effectiveConfig, endpoint, apiKey, messages, tools, options);
      if (result.content) handlers.onTextDelta?.(result.content);
      return result;
    }
  }
  const body: any = requestFormat === 'responses'
    ? buildResponsesPayload(effectiveConfig, messages, tools, options)
    : buildChatCompletionPayload(effectiveConfig, messages, tools, options);
  body.stream = true;
  if (requestFormat === 'chat-completions') {
    body.stream_options = { include_usage: true };
  }

  // 0.3.9 item 8 — fingerprint the cache-stable prefix for this stream
  // call too. Item 10 will correlate this with the SSE-final usage row
  // when the provider exposes a `cached_tokens` field.
  const streamPrefixFingerprint = computePrefixFingerprint(messages, tools);
  traceEvent('llm_call.prefix_fingerprint', {
    model: config.model,
    endpoint,
    requestFormat,
    prefixFingerprint: streamPrefixFingerprint,
    promptMessages: requestFormat === 'responses' ? body.input.length : body.messages.length,
    toolCount: body.tools?.length ?? 0,
    stream: true,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Advertise both: real providers stream SSE regardless, and the MCP
    // Streamable-HTTP SDK requires application/json + text/event-stream together
    // on any POST it sees (so a BrainRouter-as-provider request never 406s).
    'Accept': 'application/json, text/event-stream',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const requestUrl = withApiVersion(`${endpoint}/${requestFormat === 'responses' ? 'responses' : 'chat/completions'}`, config.apiVersion);
  const openStreamRequest = async (requestBody: any): Promise<{ res: Response; finish: () => void }> => {
    const timeoutMs = getCliKnobs().llmTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // DESK-6 — abort on timeout OR the user's Stop; disambiguate in the catch.
    const fetchSignal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

    const release = await acquireLLMSlot();
    try {
      options.beforeProviderRequest?.();
      const res = await fetch(requestUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: fetchSignal,
      });
      return {
        res,
        finish: () => {
          release();
          clearTimeout(timeout);
        },
      };
    } catch (err: any) {
      release();
      clearTimeout(timeout);
      if (err?.name === 'AbortError') {
        if (options.signal?.aborted) throw new InterruptError();
        throw new Error(`LLM stream request timed out after ${timeoutMs}ms.`);
      }
      throw err;
    }
  };

  let attempt = await openStreamRequest(body);
  if (!attempt.res.ok || !attempt.res.body) {
    const errText = attempt.res.body ? await attempt.res.text() : '';
    const retryBody = isInvalidReasoningEffortError(attempt.res.status, errText)
      ? stripReasoningEffortFromBody(body)
      : undefined;
    attempt.finish();
    if (retryBody) {
      traceEvent('llm_call.reasoning_effort_retry', {
        model: config.model,
        endpoint,
        requestFormat,
        status: attempt.res.status,
        stream: true,
      });
      attempt = await openStreamRequest(retryBody);
      if (!attempt.res.ok || !attempt.res.body) {
        const retryErrText = attempt.res.body ? await attempt.res.text() : '';
        const status = attempt.res.status;
        const statusText = attempt.res.statusText;
        attempt.finish();
        throw new Error(`OpenAI API error (stream): ${status} ${statusText} - ${retryErrText}`);
      }
    } else {
      throw new Error(`OpenAI API error (stream): ${attempt.res.status} ${attempt.res.statusText} - ${errText}`);
    }
  }
  const res = attempt.res;

  // Accumulators that match the non-streaming response shape.
  let content = '';
  let reasoning = '';
  const toolCallsByIndex = new Map<number, { id?: string; type?: string; function: { name: string; arguments: string } }>();
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  let finalResponse: any;
  // `length` ⇒ the provider truncated the stream at its token cap. The last
  // non-empty finish_reason in the stream wins.
  let finishReason: string | undefined;

  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      // DESK-6 — bail the instant the user presses Stop, even mid-stream: stop
      // reading the SSE and stop firing deltas. (The fetch abort also rejects
      // reader.read(), but this is the prompt, deterministic exit.)
      if (options.signal?.aborted) { try { await reader.cancel(); } catch { /* already closed */ } throw new InterruptError(); }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines (`\n\n`). Some servers
      // (LM Studio in particular) emit `\r\n\r\n` — normalize.
      let sepIdx: number;
      while ((sepIdx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx).replace(/^\r?\n\r?\n/, '');
        for (const rawLine of frame.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let frameJson: any;
          try { frameJson = JSON.parse(payload); } catch { continue; }
          if (requestFormat === 'responses') {
            if (frameJson?.type === 'error') {
              const message = frameJson.error?.message ?? frameJson.message ?? JSON.stringify(frameJson).slice(0, 400);
              throw new Error(`OpenAI Responses stream error: ${message}`);
            }
            if (frameJson?.type === 'response.output_text.delta' && typeof frameJson.delta === 'string') {
              content += frameJson.delta;
              handlers.onTextDelta?.(frameJson.delta);
              continue;
            }
            if (frameJson?.type === 'response.refusal.delta' && typeof frameJson.delta === 'string') {
              content += frameJson.delta;
              handlers.onTextDelta?.(frameJson.delta);
              continue;
            }
            if (typeof frameJson?.type === 'string' && frameJson.type.includes('reasoning') && typeof frameJson.delta === 'string') {
              reasoning += frameJson.delta;
              handlers.onReasoningDelta?.(frameJson.delta);
              continue;
            }
            if (frameJson?.type === 'response.output_item.added' && frameJson.item?.type === 'function_call') {
              const idx = typeof frameJson.output_index === 'number' ? frameJson.output_index : toolCallsByIndex.size;
              toolCallsByIndex.set(idx, {
                id: frameJson.item.call_id ?? frameJson.item.id,
                type: 'function',
                function: {
                  name: frameJson.item.name ?? '',
                  arguments: typeof frameJson.item.arguments === 'string' ? frameJson.item.arguments : '',
                },
              });
              continue;
            }
            if (frameJson?.type === 'response.function_call_arguments.delta') {
              const idx = typeof frameJson.output_index === 'number' ? frameJson.output_index : 0;
              const acc = toolCallsByIndex.get(idx) ?? { type: 'function', function: { name: '', arguments: '' } };
              if (typeof frameJson.delta === 'string') acc.function.arguments += frameJson.delta;
              toolCallsByIndex.set(idx, acc);
              continue;
            }
            if (frameJson?.type === 'response.function_call_arguments.done') {
              const idx = typeof frameJson.output_index === 'number' ? frameJson.output_index : 0;
              const acc = toolCallsByIndex.get(idx) ?? { type: 'function', function: { name: '', arguments: '' } };
              const item = frameJson.item;
              if (item?.call_id || item?.id) acc.id = item.call_id ?? item.id;
              if (item?.name) acc.function.name = item.name;
              if (typeof frameJson.arguments === 'string') acc.function.arguments = frameJson.arguments;
              else if (typeof item?.arguments === 'string') acc.function.arguments = item.arguments;
              toolCallsByIndex.set(idx, acc);
              continue;
            }
            if (frameJson?.type === 'response.output_item.done' && frameJson.item?.type === 'function_call') {
              const idx = typeof frameJson.output_index === 'number' ? frameJson.output_index : 0;
              toolCallsByIndex.set(idx, {
                id: frameJson.item.call_id ?? frameJson.item.id,
                type: 'function',
                function: {
                  name: frameJson.item.name ?? '',
                  arguments: typeof frameJson.item.arguments === 'string' ? frameJson.item.arguments : '',
                },
              });
              continue;
            }
            if (frameJson?.type === 'response.completed' || frameJson?.type === 'response.done') {
              finalResponse = frameJson.response;
              usage = normalizeProviderUsage(frameJson.response?.usage) as typeof usage;
              continue;
            }
            if (frameJson?.type === 'response.incomplete') {
              finalResponse = frameJson.response;
              usage = normalizeProviderUsage(frameJson.response?.usage) as typeof usage;
              finishReason = frameJson.response?.incomplete_details?.reason ?? 'incomplete';
              continue;
            }
            if (frameJson?.type === 'response.failed') {
              const message = frameJson.response?.error?.message ?? JSON.stringify(frameJson.response?.error ?? frameJson).slice(0, 400);
              throw new Error(`OpenAI Responses stream failed: ${message}`);
            }
            continue;
          }
          if (frameJson?.usage) {
            usage = {
              prompt_tokens: frameJson.usage.prompt_tokens,
              completion_tokens: frameJson.usage.completion_tokens,
            };
          }
          const choice = frameJson?.choices?.[0];
          if (!choice) continue;
          if (typeof choice.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason;
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            content += delta.content;
            handlers.onTextDelta?.(delta.content);
          }
          // Reasoning frames (xAI/OpenRouter use `reasoning`, others use `reasoning_content`)
          const r = (typeof delta.reasoning === 'string' ? delta.reasoning : undefined)
            ?? (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : undefined);
          if (r && r.length > 0) {
            reasoning += r;
            handlers.onReasoningDelta?.(r);
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc.index === 'number' ? tc.index : 0;
              const acc = toolCallsByIndex.get(idx) ?? { function: { name: '', arguments: '' } };
              if (tc.id) acc.id = tc.id;
              if (tc.type) acc.type = tc.type;
              // Concatenate (some providers fragment the name across frames;
              // the OpenAI-standard "name only in first frame" still works
              // because subsequent frames omit the field).
              if (tc.function?.name) acc.function.name += tc.function.name;
              if (typeof tc.function?.arguments === 'string') acc.function.arguments += tc.function.arguments;
              toolCallsByIndex.set(idx, acc);
            }
          }
        }
      }
    }
  } finally {
    attempt.finish();
  }

  const toolCalls = [...toolCallsByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ id: v.id, type: v.type ?? 'function', function: v.function }))
    .filter((tc) => tc.function.name); // drop incomplete entries

  if (requestFormat === 'responses' && finalResponse && (!content || toolCalls.length === 0)) {
    const normalized = normalizeResponsesOutput(finalResponse, endpoint, config.model);
    if (!content && normalized.content) content = normalized.content;
    if (toolCalls.length === 0 && normalized.toolCalls?.length) {
      toolCalls.push(...normalized.toolCalls);
    }
    usage = (usage ?? normalized.usage) as typeof usage;
    finishReason = finishReason ?? normalized.finishReason;
  }

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage,
    finishReason,
    reasoning: reasoning || undefined,
  };
}

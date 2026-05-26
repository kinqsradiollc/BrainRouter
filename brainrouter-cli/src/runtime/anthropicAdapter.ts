// 0.3.8-I6: Native Anthropic `/v1/messages` adapter.
//
// BrainRouter's agent loop keeps chat history in OpenAI's shape
// (`{role:'system'|'user'|'assistant'|'tool', content, tool_calls?,
// tool_call_id?, name?}`) because that's the schema every other vendor
// in the catalog already speaks. This module is the ONE place that hides
// Anthropic's asymmetric shape from the rest of the codebase:
//
//   - `system` is a top-level field, not a `messages[]` entry.
//   - Tool results come back as `tool_result` blocks WRAPPED in a `user`
//     message — there is no `tool` role.
//   - Multiple pending tool_results must collapse into one user turn
//     with a content array, not one user message per result.
//   - `tool_use` ids are vendor-assigned and must round-trip verbatim.
//   - `max_tokens` is REQUIRED (OpenAI treats it as optional).
//   - Prompt caching breakpoints and extended thinking are first-class
//     request fields, not headers.
//
// Streaming is out of scope for this PR — the agent loop still polls
// non-streaming responses.

import type { LLMConfig } from '../config/config.js';
import type { EffortLevel } from '../state/preferencesStore.js';
import { acquireLLMSlot } from './llmSemaphore.js';

const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Route to the native adapter when the profile is Anthropic AND the
 * endpoint hostname is `api.anthropic.com`, OR the explicit
 * `BRAINROUTER_ANTHROPIC_NATIVE=1` override is set (for vended /
 * reverse-proxied endpoints that still speak the native shape).
 *
 * Anything else — including `provider:'anthropic'` pointed at an
 * OpenAI-compat gateway — stays on the existing OpenAI path so we
 * don't break the OpenRouter / Anthropic-compat-shim flows.
 */
export function shouldUseAnthropicNative(
  config: LLMConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (config.provider !== 'anthropic') return false;
  if (env.BRAINROUTER_ANTHROPIC_NATIVE === '1') return true;
  const endpoint = config.endpoint ?? 'https://api.anthropic.com/v1';
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === 'api.anthropic.com' || host.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}

function modelDefaultMaxTokens(model: string): number {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 2048;
  return 4096;
}

function supportsExtendedThinking(model: string): boolean {
  // Sonnet 4.x / Opus 4.x families. Strip any vendor prefix.
  const m = model.toLowerCase().split('/').pop() ?? '';
  return /claude-(?:[a-z0-9.-]*-)?(sonnet|opus)-4/.test(m);
}

export interface AnthropicBuildOptions {
  effort?: EffortLevel;
  cacheEnabled?: boolean;
  maxTokens?: number;
  thinkingBudgetTokens?: number;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: any[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: any;
  cache_control?: { type: 'ephemeral' };
}

export interface AnthropicRequestPayload {
  model: string;
  max_tokens: number;
  system?: any;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  thinking?: { type: 'enabled'; budget_tokens: number };
}

/**
 * Pure transform: BrainRouter chat history (OpenAI shape) →
 * Anthropic `/v1/messages` request body.
 *
 * Invariants enforced here so callers don't need to know the Anthropic
 * rules:
 *   - The system message (first message with role:'system') is hoisted
 *     to the top-level `system` field and dropped from `messages`.
 *   - Consecutive `tool` role entries are merged into one synthetic
 *     `user` message whose content is an array of `tool_result` blocks.
 *   - Assistant messages with `tool_calls` emit a content array that
 *     interleaves text (when present) and `tool_use` blocks. The
 *     OpenAI tool_call.id is reused as the Anthropic tool_use.id —
 *     callers must echo it back on the matching tool_result.
 */
export function buildAnthropicRequest(
  config: LLMConfig,
  messages: any[],
  tools: any[],
  options: AnthropicBuildOptions = {},
): AnthropicRequestPayload {
  let systemText: string | undefined;

  const out: AnthropicMessage[] = [];
  let pendingToolResults: any[] | null = null;

  const flushToolResults = () => {
    if (pendingToolResults && pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults });
    }
    pendingToolResults = null;
  };

  for (const m of messages) {
    if (m.role === 'system') {
      // First system message wins; later ones are concatenated so
      // tagged system prompts (replaceTaggedSystemMessage) still flow.
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      systemText = systemText ? `${systemText}\n\n${text}` : text;
      continue;
    }
    if (m.role === 'tool') {
      const block: any = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };
      if (!pendingToolResults) pendingToolResults = [];
      pendingToolResults.push(block);
      continue;
    }
    flushToolResults();
    if (m.role === 'assistant') {
      const blocks: any[] = [];
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) blocks.push({ type: 'text', text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          let input: any = {};
          const raw = tc?.function?.arguments;
          if (typeof raw === 'string' && raw.trim()) {
            try { input = JSON.parse(raw); } catch { input = { _raw: raw }; }
          } else if (raw && typeof raw === 'object') {
            input = raw;
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name,
            input,
          });
        }
      }
      // An assistant turn with NO content + no tool_calls is dropped —
      // Anthropic rejects empty assistant turns.
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    // user
    const userText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    out.push({ role: 'user', content: [{ type: 'text', text: userText }] });
  }
  flushToolResults();

  const body: AnthropicRequestPayload = {
    model: config.model,
    max_tokens: options.maxTokens ?? modelDefaultMaxTokens(config.model),
    messages: out,
  };

  if (systemText) {
    if (options.cacheEnabled) {
      body.system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
    } else {
      body.system = systemText;
    }
  }

  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    }));
  }

  // Cache breakpoint on the last assistant message (its last block) so
  // every subsequent turn reads the prior context from cache.
  if (options.cacheEnabled) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i];
      if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.length > 0) {
        const last = msg.content[msg.content.length - 1];
        last.cache_control = { type: 'ephemeral' };
        break;
      }
    }
  }

  if (
    options.effort === 'high' &&
    supportsExtendedThinking(config.model)
  ) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: options.thinkingBudgetTokens ?? 8000,
    };
  }

  return body;
}

export interface AnthropicParsedResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  // Mapped to OpenAI's field names so the existing token accumulator
  // (which reads prompt_tokens / completion_tokens) keeps working.
  usage?: { prompt_tokens?: number; completion_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  thinking?: string;
  /**
   * Anthropic's stop reason. Surfaced verbatim so callers can detect
   * `max_tokens` truncation, `refusal`, `pause_turn`, `stop_sequence`.
   */
  stopReason?: string;
  /**
   * Raw assistant content blocks as Anthropic returned them. Required for
   * extended-thinking round-trip: when the next turn is an assistant
   * continuation after a tool_result, the API rejects the request unless
   * the previous turn's `thinking` block (with its `signature`) and any
   * `redacted_thinking` blocks are echoed back verbatim. Callers wanting
   * full round-trip safety should append a synthetic `assistant` message
   * whose `content` is exactly this array.
   */
  rawAssistantBlocks?: any[];
}

/**
 * Pure transform: Anthropic response body → BrainRouter's internal
 * `ChatResponse` shape. tool_use blocks become OpenAI-style toolCalls
 * with the Anthropic id preserved verbatim, and `input` is re-serialized
 * to the `function.arguments` JSON string the agent loop expects.
 */
export function parseAnthropicResponse(data: any): AnthropicParsedResponse {
  if (!data || typeof data !== 'object') {
    throw new Error(`Anthropic response was not a JSON object: ${JSON.stringify(data).slice(0, 400)}`);
  }
  if (data.type === 'error' || data.error) {
    const err = data.error ?? data;
    const msg = typeof err === 'string' ? err : (err.message ?? JSON.stringify(err));
    throw new Error(`Anthropic API error: ${msg}`);
  }
  const blocks: any[] = Array.isArray(data.content) ? data.content : [];
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: AnthropicParsedResponse['toolCalls'] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      thinkingParts.push(b.thinking);
    } else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      });
    }
    // redacted_thinking blocks are deliberately preserved only via
    // rawAssistantBlocks below — we never inspect their contents.
  }
  let usage: AnthropicParsedResponse['usage'];
  if (data.usage) {
    usage = {
      prompt_tokens: data.usage.input_tokens,
      completion_tokens: data.usage.output_tokens,
    };
    if (typeof data.usage.cache_read_input_tokens === 'number') {
      usage.cache_read_input_tokens = data.usage.cache_read_input_tokens;
    }
    if (typeof data.usage.cache_creation_input_tokens === 'number') {
      usage.cache_creation_input_tokens = data.usage.cache_creation_input_tokens;
    }
  }
  const result: AnthropicParsedResponse = {
    content: textParts.join(''),
    usage,
    stopReason: typeof data.stop_reason === 'string' ? data.stop_reason : undefined,
    rawAssistantBlocks: blocks,
  };
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
  if (thinkingParts.length > 0) result.thinking = thinkingParts.join('');
  return result;
}

/**
 * Anthropic API error with HTTP status + retry-after for callers that want
 * to back off on 429 / 529 instead of treating every failure the same.
 */
export class AnthropicApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterMs?: number,
    public errorType?: string,
  ) {
    super(message);
    this.name = 'AnthropicApiError';
  }
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const asNumber = Number(headerValue);
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.round(asNumber * 1000);
  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

export interface CallAnthropicOptions extends AnthropicBuildOptions {
  onThinking?: (text: string) => void;
}

export async function callAnthropic(
  config: LLMConfig,
  messages: any[],
  tools: any[],
  options: CallAnthropicOptions = {},
) {
  const rawEndpoint = config.endpoint || 'https://api.anthropic.com/v1';
  const endpoint = rawEndpoint.replace(/\/+$/, '').replace(/\/messages$/, '');
  const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    throw new Error('Anthropic API key is required (set ANTHROPIC_API_KEY or config.llm.apiKey).');
  }

  const cacheEnabled = process.env.BRAINROUTER_ANTHROPIC_CACHE === '1';
  const body = buildAnthropicRequest(config, messages, tools, {
    ...options,
    cacheEnabled: options.cacheEnabled ?? cacheEnabled,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_API_VERSION,
  };

  const timeoutMs = Number(process.env.BRAINROUTER_LLM_TIMEOUT_MS || 120000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const release = await acquireLLMSlot();
  let res: Response;
  try {
    res = await fetch(`${endpoint}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    release();
    if (err?.name === 'AbortError') {
      throw new Error(`Anthropic request timed out after ${timeoutMs}ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  release();

  if (!res.ok) {
    const errText = await res.text();
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    let errorType: string | undefined;
    try {
      const parsedErr = JSON.parse(errText);
      errorType = parsedErr?.error?.type;
    } catch {
      errorType = undefined;
    }
    // 429 = rate_limit, 529 = overloaded — surface distinctly so callers
    // (or BRAINROUTER retry policies) can back off rather than dying.
    throw new AnthropicApiError(
      `Anthropic API error: ${res.status} ${res.statusText} - ${errText}`,
      res.status,
      retryAfterMs,
      errorType,
    );
  }

  const data = await res.json() as any;
  const parsed = parseAnthropicResponse(data);
  if (parsed.thinking && options.onThinking) {
    options.onThinking(parsed.thinking);
  }
  return {
    content: parsed.content,
    toolCalls: parsed.toolCalls,
    usage: parsed.usage,
    stopReason: parsed.stopReason,
    rawAssistantBlocks: parsed.rawAssistantBlocks,
  };
}

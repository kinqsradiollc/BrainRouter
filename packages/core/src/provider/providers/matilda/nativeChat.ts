/**
 * ADR-058 D13 — Matilda's NATIVE chat surface (`POST …/api/chat`, SSE).
 *
 * Why a native adapter: Matilda's OpenAI-compatible endpoint ignores `tools`
 * entirely; tool calling exists only here, where the server templates
 * `clientTools` for the model and the model answers with DSML blocks in the
 * token stream (see ./dsml.ts). Everything in this file is what the live
 * endpoint measured, not what the docs implied:
 *
 *  - Body: `{ messages, clientTools?, conversation_id, responseMode:'auto' }`.
 *    `input` is an SDK convenience (400 on the wire); `role:'system'` is rejected
 *    (400); `role:'assistant'` history IS accepted. The server never restores
 *    context from `conversation_id` (with or without `persist`) — so the full
 *    user+assistant history travels every turn, exactly like the OpenAI path,
 *    and `conversation_id` is only a per-session grouping key.
 *  - Instructions PREFIXED onto the task message suppress client-tool calls
 *    (0/3 at every length, neutral or real text); the SAME instructions as their
 *    own prior user message, ending with an explicit client-tools hint, restore
 *    them (3/3 with BrainRouter's real prompt). So the system prompt is sent as
 *    `messages[0]` + the hint, and the task stays its own clean message.
 *  - `responseMode:'auto'` is required for client tools (omitted/deep/instant →
 *    server-side tools run instead; 0/3). The SDK's "code specialist" routing
 *    intent text also suppresses them — it is deliberately NOT sent.
 *  - Limits: 64 KiB request body (403 at the edge), ≤64 `clientTools` (400),
 *    ~20k dense chars per message (422). No OpenAI-style `model` field.
 *  - Tool results go back as a user message `[Client tool result: <name>]\n…`
 *    (the SDK's own roundtrip shape).
 *
 * Browser-safe: no node:* imports.
 */
import type { CleanMessage, CleanTool, NativeBuildInput, NativeOutput } from '../../../agent/transport/nativeProviders.js';
import { sseEvents, type NativeStreamHandlers } from '../../../agent/transport/nativeProviderStream.js';
import { capMessageContent, utf8Bytes } from '../../requestLimits.js';
import { rankAndCapTools } from '../../../tool/policy/toolBudget.js';
import { createDsmlInterceptor } from './dsml.js';

export const MATILDA_NATIVE_LIMITS = {
  /** Edge-enforced request-body cap: 65 536 bytes → 200, 65 537 → 403. */
  maxBodyBytes: 65_536,
  /** `clientTools must contain no more than 64 elements` (400). */
  maxClientTools: 64,
  /** Conservative per-message cap under the ~20k-char 422 boundary. */
  maxMessageChars: 16_000,
  /** `clientTools.N.description must be shorter than or equal to 2000 characters` (400). */
  maxToolDescriptionChars: 2_000,
} as const;

/** The sentence that makes the model actually use advertised client tools
 *  (measured: bare task ~2/3, with this hint as the tail of `messages[0]` 3/3). */
export const MATILDA_CLIENT_TOOLS_HINT =
  'You have CLIENT TOOLS advertised for this turn (listed by the platform). When a task needs one, call it by ' +
  'emitting a DSML tool call block for that tool — do not describe the call in prose and do not claim you lack the tool.';

export interface MatildaChatMessage { role: 'user' | 'assistant'; content: string }
export interface MatildaClientTool { name: string; description: string; parameters: unknown }
export interface MatildaChatPayload {
  messages: MatildaChatMessage[];
  clientTools?: MatildaClientTool[];
  conversation_id: string;
  responseMode: 'auto';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : typeof (p as { text?: unknown })?.text === 'string' ? (p as { text: string }).text : '')).join('');
  }
  return String(content);
}

function latestUserText(messages: CleanMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return textOf(messages[i].content);
  }
  return '';
}

/** Per-session conversation ids (a grouping key only — see the header). Keyed by
 *  the calling session when the transport knows it, else by the conversation's
 *  first user message so the id is still stable across a session's turns. */
const conversationIds = new Map<string, string>();
export function matildaConversationIdFor(sessionKey: string | undefined, messages: CleanMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  const key = sessionKey?.trim() || `first:${textOf(first?.content).slice(0, 200)}`;
  let id = conversationIds.get(key);
  if (!id) {
    id = globalThis.crypto.randomUUID();
    conversationIds.set(key, id);
  }
  return id;
}

/** Build the native body from the transport's normalized input. */
export function buildMatildaChatPayload(input: NativeBuildInput, opts: { conversationId: string }): MatildaChatPayload {
  const { maxBodyBytes, maxClientTools, maxMessageChars, maxToolDescriptionChars } = MATILDA_NATIVE_LIMITS;
  const hasTools = input.tools.length > 0;
  // A tool description over the validator's cap rejects the WHOLE request, so
  // every description is tail-cut (the lead sentence is what the model reads).
  const describe = (text: string | undefined): string => {
    const t = text ?? '';
    return t.length <= maxToolDescriptionChars ? t : t.slice(0, maxToolDescriptionChars - 1) + '…';
  };
  const messages: MatildaChatMessage[] = [];

  // 1) The system prompt + the client-tools hint as their OWN prior user message.
  const system = input.system.trim();
  if (system || hasTools) {
    const hint = hasTools ? MATILDA_CLIENT_TOOLS_HINT : '';
    const room = Math.max(0, maxMessageChars - (hint ? hint.length + 2 : 0));
    const sys = system ? (capMessageContent({ content: system }, room).content as string) : '';
    messages.push({ role: 'user', content: [sys, hint].filter(Boolean).join('\n\n') });
  }

  // 2) The clean history. user → user; assistant → its visible text plus a
  //    compact note of any tool calls it made; tool results → user messages in
  //    the SDK's roundtrip shape. (The model's own DSML is never echoed back.)
  for (const m of input.messages) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: textOf(m.content) });
    } else if (m.role === 'assistant') {
      const parts = [textOf(m.content)];
      const calls = (m as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls ?? [];
      for (const tc of calls) parts.push(`[Called client tool: ${tc.function?.name ?? 'tool'}(${tc.function?.arguments ?? ''})]`);
      const content = parts.filter(Boolean).join('\n');
      if (content) messages.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      const name = (m as { name?: string }).name ?? 'tool';
      messages.push({ role: 'user', content: `[Client tool result: ${name}]\n${textOf(m.content)}` });
    }
  }

  const payload: MatildaChatPayload = {
    messages: messages.map((msg) => capMessageContent(msg, maxMessageChars)),
    conversation_id: opts.conversationId,
    responseMode: 'auto',
  };
  if (!hasTools) return payload;

  // 3) clientTools: at most 64, the most task-relevant first, then fitted to the
  //    byte budget (binary search on the largest relevance-ranked top-k that fits).
  const taskText = latestUserText(input.messages);
  const ranked = input.tools.map((t: CleanTool) => ({ name: t.name, description: t.description, tool: t }));
  const apply = (k: number): number => {
    const kept = k >= ranked.length ? ranked : rankAndCapTools(ranked, taskText, k).kept;
    payload.clientTools = kept.map((r) => ({
      name: r.tool.name,
      description: describe(r.tool.description),
      parameters: r.tool.inputSchema ?? { type: 'object', properties: {} },
    }));
    return utf8Bytes(JSON.stringify(payload));
  };
  const max = Math.min(ranked.length, maxClientTools);
  if (apply(max) <= maxBodyBytes) return payload;
  let lo = 0;
  let hi = max - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2); // ≥ 1 while lo < hi
    if (apply(mid) <= maxBodyBytes) lo = mid; else hi = mid - 1;
  }
  if (lo === 0) delete payload.clientTools; else apply(lo);
  return payload;
}

/**
 * Consume the native SSE stream into the transport's `NativeOutput`. Text
 * deltas pass through the DSML interceptor so tool calls never reach the
 * visible text; a `client_tool_call` event (the server-parsed form) is honoured
 * too, de-duplicated against any DSML block for the same call; `replace` drops
 * the text accumulated so far (the server restarted the answer); `error` throws.
 */
export async function parseMatildaChatStream(
  chunks: AsyncIterable<string>,
  handlers: NativeStreamHandlers,
  endpoint: string,
  model: string,
): Promise<NativeOutput> {
  let text = '';
  const toolCalls: NonNullable<NativeOutput['toolCalls']> = [];
  const seen = new Set<string>();
  let usage: NativeOutput['usage'];
  let n = 0;
  const record = (name: string, args: string, id?: string): void => {
    const key = `${name} ${args}`;
    if (seen.has(key)) return;
    seen.add(key);
    toolCalls.push({ id: id ?? `call_matilda_${++n}`, type: 'function', function: { name, arguments: args } });
  };
  const interceptor = createDsmlInterceptor(
    (t) => { text += t; handlers.onTextDelta?.(t); },
    (call) => record(call.name, call.arguments, call.id),
  );

  for await (const ev of sseEvents(chunks)) {
    let j: Record<string, unknown> | null = null;
    try { j = JSON.parse(ev.data) as Record<string, unknown>; } catch { j = null; }
    switch (ev.event) {
      case 'token':
        if (typeof j?.content === 'string') interceptor.push(j.content);
        break;
      case 'thinking': {
        const t = typeof j?.content === 'string' ? j.content : typeof j?.text === 'string' ? j.text : '';
        if (t) handlers.onReasoningDelta?.(t);
        break;
      }
      case 'client_tool_call':
        if (typeof j?.name === 'string') {
          const args = j.args && typeof j.args === 'object' ? j.args : {};
          record(j.name, JSON.stringify(args), typeof j.id === 'string' ? j.id : undefined);
        }
        break;
      case 'replace':
        interceptor.reset();
        text = '';
        break;
      case 'usage':
        if (j && typeof j === 'object') {
          usage = { ...(typeof j.output_tokens === 'number' ? { completion_tokens: j.output_tokens } : {}), ...j };
        }
        break;
      case 'error': {
        const err: Error & { status?: number } = new Error(
          `matilda-chat stream error from ${endpoint} (${model}): ${String(j?.code ?? '')} ${String(j?.message ?? ev.data)}`.trim(),
        );
        throw err;
      }
      default:
        // stream_init, generation_status, tool_start, tool_result, tool_progress,
        // status, cursor, truncated, safety_replace, done — nothing to surface here.
        break;
    }
  }
  interceptor.flush();
  return {
    content: text,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
  };
}

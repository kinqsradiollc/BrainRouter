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
import { pinnedToolNames, rankAndCapTools } from '../../../tool/policy/toolBudget.js';
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
  persist: false;
}

/** The roundtrip header the platform's own tool loop uses: a failed tool comes
 *  back as an error, not as a result the model might act on as if it succeeded. */
export function toolResultHeader(name: string, failed: boolean): string {
  return failed ? `[Client tool error: ${name}]` : `[Client tool result: ${name}]`;
}

/** Tool output is untrusted input: a page or file that happens to contain the
 *  roundtrip header must not be able to forge a second "result" inside the one
 *  message. Defanged, not removed, so the text is still readable. */
export function neutralizeToolResultHeaders(content: string): string {
  return content.replace(/\[Client tool (result|error):/g, '[client tool $1:');
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
      const failed = (m as { isError?: boolean }).isError === true;
      messages.push({ role: 'user', content: `${toolResultHeader(name, failed)}\n${neutralizeToolResultHeaders(textOf(m.content))}` });
    }
  }

  const payload: MatildaChatPayload = {
    messages: messages.map((msg) => capMessageContent(msg, maxMessageChars)),
    conversation_id: opts.conversationId,
    responseMode: 'auto',
    // Agent turns are BrainRouter's, not the person's Matilda web-app chat
    // history: never persist them there (the official agent SDK sends the same).
    persist: false,
  };
  if (!hasTools) return payload;

  // 3) clientTools: at most 64, the most task-relevant first, then fitted to the
  //    byte budget (binary search on the largest relevance-ranked top-k that fits).
  //    Runtime-mandated tools and tools the latest user text names verbatim are
  //    pinned ahead of relevance — the first live turns cut `profile_stage` on a
  //    question about the economy and the model, told to call it, rightly said
  //    no such tool existed.
  const taskText = latestUserText(input.messages);
  const ranked = input.tools.map((t: CleanTool) => ({ name: t.name, description: t.description, tool: t }));
  const pinned = pinnedToolNames(taskText, ranked.map((r) => r.name));
  const apply = (k: number): number => {
    const kept = k >= ranked.length ? ranked : rankAndCapTools(ranked, taskText, k, { pinned }).kept;
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

const SERVER_TOOL_OUTPUT_PREVIEW_CHARS = 400;

/** One reasoning-stream line for a server-side tool event, or '' when the
 *  payload carries nothing readable. Exported for tests. */
export function describeServerTool(event: string, j: Record<string, unknown> | null): string {
  const tool = typeof j?.tool === 'string' && j.tool ? j.tool : 'tool';
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : JSON.stringify(v));
  const label = `Matilda server-side ${tool}`;
  if (event === 'tool_start') {
    const input = str(j?.input ?? j?.inputOrArgs ?? j?.args);
    return `[${label}] ${input || 'started'}\n`;
  }
  if (event === 'tool_progress') {
    const message = str(j?.message);
    return message ? `[${label}] ${message}\n` : '';
  }
  const status = typeof j?.status === 'string' ? j.status : 'done';
  const output = str(j?.output);
  const preview = output.length > SERVER_TOOL_OUTPUT_PREVIEW_CHARS ? `${output.slice(0, SERVER_TOOL_OUTPUT_PREVIEW_CHARS)}…` : output;
  return `[${label} → ${status}]${preview ? ` ${preview}` : ''}\n`;
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
  let endedEarly = false;
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
      // The platform's safety layer replaced the answer: the text so far is
      // withdrawn and the replacement (when one is given) is the answer. The
      // categories are recorded as reasoning activity so the person can see
      // WHY the answer changed; painted deltas cannot be recalled, but the
      // returned content — what the transcript keeps — is the replacement.
      case 'safety_replace': {
        interceptor.reset();
        const message = typeof j?.message === 'string' ? j.message : typeof j?.content === 'string' ? j.content : '';
        const categories = Array.isArray(j?.categories) ? (j.categories as unknown[]).filter((c): c is string => typeof c === 'string') : [];
        text = message;
        handlers.onReasoningDelta?.(`[Matilda safety replaced the answer${categories.length ? `: ${categories.join(', ')}` : ''}]\n`);
        if (message) handlers.onTextDelta?.(message);
        break;
      }
      case 'usage':
        if (j && typeof j === 'object') {
          usage = {
            ...(typeof j.input_tokens === 'number' ? { prompt_tokens: j.input_tokens } : {}),
            ...(typeof j.output_tokens === 'number' ? { completion_tokens: j.output_tokens } : {}),
            ...j,
          };
        }
        break;
      // Matilda's OWN tools (web `search`, code execution, URL reads) run on the
      // platform before the model answers and cannot be disabled. They are not
      // client tools, so they never become tool calls — but a person watching
      // the turn otherwise sees nothing happen while the answer arrives
      // pre-researched. Surface them as reasoning-stream activity, the channel
      // for "what the model did before it spoke". Wire shapes (measured):
      //   tool_start    {"tool":"search","input":"<query>"}
      //   tool_progress {"tool":"search","message":"…"}
      //   tool_result   {"tool":"search","status":"success","input":"…","output":"Found sources: …"}
      case 'tool_start':
      case 'tool_progress':
      case 'tool_result': {
        const line = describeServerTool(ev.event, j);
        if (line) handlers.onReasoningDelta?.(line);
        break;
      }
      case 'error': {
        // Wire shape: {"code":"request_budget_exceeded","error":"The assistant
        // ran out of steps before it could finish."} — the text is under `error`.
        const code = typeof j?.code === 'string' && j.code ? j.code : 'unknown';
        const detail = typeof j?.error === 'string' ? j.error : typeof j?.message === 'string' ? j.message : ev.data;
        // A partial answer is worth more than an error. The platform's OWN step
        // or time budget (`request_budget_exceeded`, `deadline_exceeded`) can end
        // an answer it had already started: keep what was said, say why it
        // stopped, and let the turn finish — the official SDK keeps the text the
        // same way. With nothing said yet there is nothing to keep: throw, with
        // the code on the error so the router can decide whether to retry.
        if (text.trim() || toolCalls.length) {
          handlers.onReasoningDelta?.(`[Matilda ended the answer early: ${code} — ${detail}]\n`);
          if (toolCalls.length === 0) {
            const trailer = `\n\n_(Matilda stopped early: ${detail})_`;
            text += trailer;
            handlers.onTextDelta?.(trailer);
          }
          endedEarly = true;
          break;
        }
        const err: Error & { status?: number; code?: string } = new Error(
          `matilda-chat stream error from ${endpoint} (${model}): ${code} ${detail}`.trim(),
        );
        err.code = code;
        throw err;
      }
      default:
        // stream_init, generation_status, status, cursor, truncated, done —
        // nothing to surface here.
        break;
    }
    if (endedEarly) break;
  }
  interceptor.flush();
  return {
    content: text,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(usage ? { usage } : {}),
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
  };
}

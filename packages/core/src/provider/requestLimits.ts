/**
 * ADR-058 D12 — shape an outgoing chat-completions request to a provider's
 * declared per-request limits (`ProviderDefinition.limits`).
 *
 * One implementation for every path that fronts a provider: the desktop/CLI
 * transport (`buildChatCompletionPayload`) and the server gateway
 * (`buildUpstreamChatPayload`) both hand their WIRE-shaped body here, so a
 * constrained endpoint gets a request it can accept no matter which surface
 * built it. The numbers this exists for are Matilda's, measured against the live
 * endpoint: a 64 KiB request body (65 536 bytes → 200, 65 537 → 403
 * `{"error":"forbidden"}`, enforced at the edge BEFORE validation) and 16 000
 * characters of `content` per message (16 001 → 400).
 *
 * Browser-safe: no node:* imports (`TextEncoder` for byte length).
 */
import { pinnedToolNames, rankAndCapTools } from '../tool/policy/toolBudget.js';

export interface ProviderRequestLimits {
  /** Largest serialized request body, in UTF-8 wire bytes (what Content-Length carries). */
  maxBodyBytes?: number;
  /** Longest `content` string any ONE message may carry, in characters, every role. */
  maxMessageChars?: number;
}

/** A wire-shaped chat-completions tool spec (`{type:'function', function:{…}}`). */
export interface WireToolSpec {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
  [key: string]: unknown;
}

/** The minimal wire body the shaper reads — the transport's payload and the
 *  gateway's passthrough body both satisfy it. */
export interface ShapeableChatBody {
  messages: Array<{ role?: string; content?: unknown; [key: string]: unknown }>;
  tools?: WireToolSpec[];
  tool_choice?: unknown;
  [key: string]: unknown;
}

/** UTF-8 byte length of a string — what Content-Length carries. The agent prompt
 *  is full of multi-byte characters (em-dashes, ellipses, bullets: 3 bytes each),
 *  so a body measured in JS chars can sit "under" a budget the request is over. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The latest user turn's text — the relevance signal for fitting tools to a
 *  byte budget (the same signal the MCP tool budget ranks by). */
export function latestUserTextFrom(messages: ShapeableChatBody['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
    }
  }
  return '';
}

const CONTENT_CAP_MARKER = "\n…[truncated to the provider's per-message limit]";

/** Cut from the TAIL: BrainRouter front-loads the task-execution instructions,
 *  so the head is the part worth keeping. The marker is budgeted into the limit
 *  so the result never exceeds it. */
function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - CONTENT_CAP_MARKER.length);
  return text.slice(0, room) + CONTENT_CAP_MARKER;
}

/** `limits.maxMessageChars` applied to one message; multi-part (vision) content
 *  caps each text part and passes image parts through. Returns the same object
 *  when nothing needs cutting. */
export function capMessageContent<M extends { content?: unknown }>(m: M, max: number | undefined): M {
  if (!max || max <= 0 || !m) return m;
  const c = m.content;
  if (typeof c === 'string') return c.length > max ? { ...m, content: capText(c, max) } : m;
  if (Array.isArray(c)) {
    return { ...m, content: c.map((p: any) => (typeof p?.text === 'string' ? { ...p, text: capText(p.text, max) } : p)) };
  }
  return m;
}

/** `limits.maxBodyBytes` — fit the tool list to the bytes left after the
 *  messages. Binary-searches the largest k such that the body carrying the top-k
 *  most task-relevant tool specs serializes within the budget (bytes are
 *  monotone in k; `rankAndCapTools` ranks the way the MCP tool budget does), so a
 *  constrained endpoint gets the tools that matter for THIS task — never a blind
 *  prefix cut of an 81-local-tool list that would drop core agent tools. Tools a
 *  runtime guardrail demands by name (`profile_stage`, `task_agent`, …) and tools
 *  the latest user text names verbatim are pinned ahead of relevance: a fit that
 *  dropped `profile_stage` on a question about the economy left the model told
 *  to call a tool it was never given. If even zero tools cannot fit (the messages
 *  alone exceed the budget) the tools are dropped and the request goes out as-is
 *  — that is a context-length problem for the provider to report, not one a tool
 *  cut can solve. Mutates in place. */
function fitToolSpecsToByteBudget(body: ShapeableChatBody, specs: WireToolSpec[], taskText: string, maxBodyBytes: number): void {
  const measure = (): number => utf8Bytes(JSON.stringify(body));
  if (measure() <= maxBodyBytes) return;
  // Rank on the model-facing name/description the spec carries.
  const ranked = specs.map((spec) => ({ name: String(spec.function?.name ?? ''), description: spec.function?.description, spec }));
  const pinned = pinnedToolNames(taskText, ranked.map((r) => r.name));
  const originalToolChoice = body.tool_choice;
  const withTopK = (k: number): void => {
    if (k <= 0) { delete body.tools; delete body.tool_choice; return; }
    // `rankAndCapTools` returns the whole list when k >= length (and when
    // k <= 0, hence the explicit zero branch above).
    const kept = k >= ranked.length ? ranked : rankAndCapTools(ranked, taskText, k, { pinned }).kept;
    body.tools = kept.map((r) => r.spec);
    body.tool_choice = originalToolChoice ?? 'auto';
  };
  let lo = 0;
  let hi = specs.length - 1; // the full list is known not to fit
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    withTopK(mid);
    if (measure() <= maxBodyBytes) lo = mid; else hi = mid - 1;
  }
  withTopK(lo);
}

/** Bytes the history must leave for the tool list when tools are offered: the
 *  D19 measurement put the essential-plus-relevant set for a real turn at
 *  ~20 KB; below that the fit starts dropping tools the task needs. */
export const HISTORY_RESERVE_FOR_TOOLS_BYTES = 20_000;
/** Framing bytes of the body around the messages (ids, mode flags, JSON). */
const HISTORY_FRAMING_BYTES = 1_024;

/** What an elided tool result says in place of its content. */
export function elidedToolResultNote(chars: number): string {
  return `(result of ${chars.toLocaleString('en-US')} chars from earlier in this session elided to fit the provider's request limit — call the tool again if you need it)`;
}

/**
 * `limits.maxBodyBytes`, the other half: a session whose HISTORY alone exceeds
 * the budget (eight 16k-char tool results are ~100 KB) cannot be saved by any
 * tool cut — the edge answers 403 before the model sees a byte. The elastic part
 * of history is old tool output: elide the OLDEST tool results first (their
 * content becomes a one-line note; the header stays so the pairing is intact),
 * always keeping the newest tool result whole (it is what the model acts on
 * next) and never touching anything that is not a tool result. Returns a new
 * array when something was elided, the same array otherwise.
 *
 * `measure` serializes the candidate messages the way the wire will (the
 * native and the compat bodies frame them differently); `isToolResult` and
 * `elide` are the wire's own shapes.
 */
export function elideOldestToolResultsToBudget<M>(
  messages: M[],
  budgetBytes: number,
  wire: {
    measure: (messages: M[]) => number;
    isToolResult: (m: M) => boolean;
    contentChars: (m: M) => number;
    elide: (m: M) => M;
  },
): M[] {
  if (!(budgetBytes > 0) || wire.measure(messages) <= budgetBytes) return messages;
  const out = messages.slice();
  const resultIdx = out.map((m, i) => (wire.isToolResult(m) ? i : -1)).filter((i) => i >= 0);
  // Oldest first, the newest result never.
  for (const i of resultIdx.slice(0, -1)) {
    if (wire.contentChars(out[i]) < 200) continue; // already a note or trivially small
    out[i] = wire.elide(out[i]);
    if (wire.measure(out) <= budgetBytes) return out;
  }
  return out;
}

/**
 * Shape a wire-shaped chat-completions body to a provider's declared limits:
 * cap every message's content to `maxMessageChars` (tail cut, marked), elide the
 * oldest tool results when the history alone would not fit, then fit the tool
 * list — the elastic part once messages are capped — to `maxBodyBytes` by task
 * relevance. A provider that declares no limits gets the body back
 * byte-for-byte untouched. Mutates and returns `body`.
 */
export function shapeChatCompletionToLimits<B extends ShapeableChatBody>(
  body: B,
  limits: ProviderRequestLimits | undefined,
  opts: { taskText?: string } = {},
): B {
  if (!limits) return body;
  if (limits.maxMessageChars && limits.maxMessageChars > 0 && Array.isArray(body.messages)) {
    body.messages = body.messages.map((m) => capMessageContent(m, limits.maxMessageChars));
  }
  if (limits.maxBodyBytes && limits.maxBodyBytes > 0 && Array.isArray(body.messages)) {
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const budget = limits.maxBodyBytes - HISTORY_FRAMING_BYTES - (hasTools ? HISTORY_RESERVE_FOR_TOOLS_BYTES : 0);
    type Msg = NonNullable<B['messages']>[number];
    const text = (m: Msg): string => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('') : '');
    body.messages = elideOldestToolResultsToBudget<Msg>(body.messages, budget, {
      measure: (ms) => utf8Bytes(JSON.stringify({ ...body, messages: ms, tools: undefined })),
      isToolResult: (m) => m?.role === 'tool',
      contentChars: (m) => text(m).length,
      elide: (m) => ({ ...m, content: elidedToolResultNote(text(m).length) }),
    });
  }
  if (limits.maxBodyBytes && limits.maxBodyBytes > 0 && Array.isArray(body.tools) && body.tools.length > 0) {
    const taskText = opts.taskText ?? latestUserTextFrom(body.messages ?? []);
    fitToolSpecsToByteBudget(body, body.tools, taskText, limits.maxBodyBytes);
  }
  return body;
}

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
import { rankAndCapTools } from '../tool/policy/toolBudget.js';

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
 *  prefix cut of an 81-local-tool list that would drop core agent tools. If even
 *  zero tools cannot fit (the messages alone exceed the budget) the tools are
 *  dropped and the request goes out as-is — that is a context-length problem for
 *  the provider to report, not one a tool cut can solve. Mutates in place. */
function fitToolSpecsToByteBudget(body: ShapeableChatBody, specs: WireToolSpec[], taskText: string, maxBodyBytes: number): void {
  const measure = (): number => utf8Bytes(JSON.stringify(body));
  if (measure() <= maxBodyBytes) return;
  // Rank on the model-facing name/description the spec carries.
  const ranked = specs.map((spec) => ({ name: String(spec.function?.name ?? ''), description: spec.function?.description, spec }));
  const originalToolChoice = body.tool_choice;
  const withTopK = (k: number): void => {
    if (k <= 0) { delete body.tools; delete body.tool_choice; return; }
    // `rankAndCapTools` returns the whole list when k >= length (and when
    // k <= 0, hence the explicit zero branch above).
    const kept = k >= ranked.length ? ranked : rankAndCapTools(ranked, taskText, k).kept;
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

/**
 * Shape a wire-shaped chat-completions body to a provider's declared limits:
 * cap every message's content to `maxMessageChars` (tail cut, marked), then fit
 * the tool list — the only elastic part once messages are capped — to
 * `maxBodyBytes` by task relevance. A provider that declares no limits gets the
 * body back byte-for-byte untouched. Mutates and returns `body`.
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
  if (limits.maxBodyBytes && limits.maxBodyBytes > 0 && Array.isArray(body.tools) && body.tools.length > 0) {
    const taskText = opts.taskText ?? latestUserTextFrom(body.messages ?? []);
    fitToolSpecsToByteBudget(body, body.tools, taskText, limits.maxBodyBytes);
  }
  return body;
}

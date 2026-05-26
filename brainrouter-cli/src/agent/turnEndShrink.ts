/**
 * Turn-end tool-result auto-shrink (0.3.9 item 12).
 *
 * `prompt/toolCompaction.ts` (item 3) already compacts tool results
 * *on the way in*. This pass handles the complementary problem:
 * tool results that were oversized on a PRIOR turn and now drag
 * through every cached prefix request. The full result was useful
 * when read; it isn't useful (at full size) ten turns later.
 *
 * Algorithm — once a turn finishes (no in-flight tool_calls):
 *
 *   1. Walk the chat history.
 *   2. For each `role: 'tool'` message whose content exceeds
 *      `TURN_END_RESULT_CAP_TOKENS`, replace the content with the
 *      same TokenJuice-lite compaction output as item 3.
 *   3. Leave the transcript layer alone — full raw outputs stay
 *      there for the user to replay.
 *
 * Cache implications: the *prefix* region was never carrying tool
 * results (those live in the append-only log per item 8). Shrinking
 * a log entry produces exactly one cache miss on the affected
 * message, then re-warms on every subsequent turn. Net win.
 *
 * Adapted from openSrc/DeepSeek-Reasonix/src/loop/shrink.ts
 * (`shrinkOversizedToolResultsByTokens`) and `src/context-manager.ts`
 * (HISTORY_FOLD_THRESHOLD).
 */

import { compactToolOutput } from '../prompt/toolCompaction.js';

/** Default cap. Overridable via BRAINROUTER_TURN_END_RESULT_CAP_TOKENS. */
export const TURN_END_RESULT_CAP_TOKENS = 3000;
/** Default proactive ratio (40% of `ctxMax`). Overridable via env. */
export const PROACTIVE_SHRINK_RATIO = 0.4;
/** Cheap token estimator that matches Agent.estimateTokens (1 token ≈ 4 chars). */
export const APPROX_CHARS_PER_TOKEN = 4;

export interface ChatHistoryEntry {
  role: string;
  content?: string | unknown;
  name?: string;
  tool_call_id?: string;
  // Tag we set after shrinking so we don't re-shrink an already-shrunk message.
  _shrunk?: boolean;
}

export interface TurnEndShrinkResult {
  shrunkCount: number;
  charsSaved: number;
  tokensSaved: number;
}

export interface TurnEndShrinkOptions {
  /** Per-message cap. Default `TURN_END_RESULT_CAP_TOKENS`. */
  capTokens?: number;
  /** `compactToolOutput` is consulted for each oversized message. */
  /** Hook used in tests to bypass the real compactor for deterministic shape. */
  compact?: (input: { toolName: string; output: string }) => { inlineText: string };
}

/**
 * Walk the chat history and shrink any oversized tool messages
 * in-place. Returns the savings summary so the agent can update
 * memoryMetrics.compactedToolCharsAvoided.
 */
export function shrinkOversizedToolResults(
  history: ChatHistoryEntry[],
  options: TurnEndShrinkOptions = {},
): TurnEndShrinkResult {
  const cap = options.capTokens ?? readCapTokensFromEnv();
  const charCap = cap * APPROX_CHARS_PER_TOKEN;
  const compact = options.compact ?? ((input) => {
    const compacted = compactToolOutput({ toolName: input.toolName, output: input.output });
    if (compacted) return { inlineText: compacted.inlineText };
    return { inlineText: shortPreview(input.output, charCap) };
  });

  let shrunkCount = 0;
  let charsSaved = 0;
  for (const msg of history) {
    if (msg.role !== 'tool') continue;
    if (msg._shrunk === true) continue;
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length === 0) continue;
    if (content.length <= charCap) continue;
    const before = content.length;
    const compacted = compact({ toolName: msg.name ?? 'unknown', output: content });
    msg.content = compacted.inlineText;
    msg._shrunk = true;
    shrunkCount += 1;
    charsSaved += Math.max(0, before - (typeof msg.content === 'string' ? msg.content.length : 0));
  }
  return {
    shrunkCount,
    charsSaved,
    tokensSaved: Math.round(charsSaved / APPROX_CHARS_PER_TOKEN),
  };
}

/**
 * Should the agent trigger the proactive (mid-iteration) shrink before
 * the next iteration? Returns true when the total log size exceeds
 * `ratio * ctxMax`. Cheap O(n) over the history; the agent calls this
 * inside its iteration loop, not just at turn-end.
 */
export function shouldProactivelyShrink(
  history: ChatHistoryEntry[],
  ctxMaxTokens: number,
  ratio: number = readProactiveRatioFromEnv(),
): boolean {
  if (ctxMaxTokens <= 0) return false;
  let chars = 0;
  for (const m of history) {
    const s = typeof m.content === 'string' ? m.content : '';
    chars += s.length;
  }
  const tokens = chars / APPROX_CHARS_PER_TOKEN;
  return tokens > ratio * ctxMaxTokens;
}

function shortPreview(text: string, charCap: number): string {
  if (text.length <= charCap) return text;
  const head = text.slice(0, charCap - 200);
  return `${head}\n…[${(text.length - head.length).toLocaleString()} chars omitted by turn-end shrink; full output retained in transcript]`;
}

function readCapTokensFromEnv(): number {
  const raw = Number.parseInt(process.env.BRAINROUTER_TURN_END_RESULT_CAP_TOKENS ?? '', 10);
  if (Number.isFinite(raw) && raw >= 200 && raw <= 200_000) return raw;
  return TURN_END_RESULT_CAP_TOKENS;
}

function readProactiveRatioFromEnv(): number {
  const raw = Number.parseFloat(process.env.BRAINROUTER_TURN_END_SHRINK_RATIO ?? '');
  if (Number.isFinite(raw) && raw > 0 && raw < 1) return raw;
  return PROACTIVE_SHRINK_RATIO;
}

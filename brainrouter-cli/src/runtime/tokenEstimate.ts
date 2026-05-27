/**
 * Content-aware token estimator.
 *
 * The old `Math.ceil(text.length / 4)` worked for English prose but
 * blew up on two real workloads:
 *
 *   1. **Code-heavy turns** — a 12KB tool-result dump of TypeScript
 *      ASTs averages closer to 3.0–3.5 chars/token because every
 *      identifier is short, every operator is one char, and the
 *      provider's BPE merges fewer common subwords.
 *
 *   2. **CJK content** — Chinese / Japanese / Korean text averages
 *      1.0–2.0 chars/token. The 4× ratio undercounts by 2–4×, which
 *      meant a Chinese-heavy paste would silently blow past the
 *      compaction threshold and the next request would 4xx with a
 *      context-overflow error.
 *
 * Strategy: bucket characters into three classes and apply a
 * per-bucket ratio. The result is closer to a real BPE tokenizer
 * than a constant divisor without paying the runtime cost of
 * actually invoking one.
 *
 * The estimator is only consulted when the actual `prompt_tokens`
 * from the LAST response.usage isn't available — i.e. turn 1
 * (no usage yet) and silent/offline tests. Subsequent turns use
 * the authoritative provider count from `agent.lastTurnUsage`.
 *
 * For accuracy reference, OpenAI's own `tiktoken` library reports
 * ~3.5 char/token on mixed English+code and ~1.5 char/token on
 * CJK. We deliberately under-estimate (rounding to a SAFER higher
 * token count) so compaction trips early rather than late.
 */

const CJK_RANGES: Array<[number, number]> = [
  [0x3000, 0x303F],  // CJK symbols and punctuation
  [0x3040, 0x309F],  // Hiragana
  [0x30A0, 0x30FF],  // Katakana
  [0x3400, 0x4DBF],  // CJK Extension A
  [0x4E00, 0x9FFF],  // CJK Unified Ideographs
  [0xAC00, 0xD7AF],  // Hangul Syllables
  [0xF900, 0xFAFF],  // CJK Compatibility
  [0xFF00, 0xFFEF],  // Halfwidth and Fullwidth Forms
];

const CODE_DENSITY_CHARS = new Set(['{', '}', '[', ']', '(', ')', ';', ':', ',', '<', '>', '=', '/', '\\']);

/**
 * Per-character classification → per-class chars-per-token estimate.
 * Lower number = denser tokens (more tokens per char).
 */
const CHARS_PER_TOKEN = {
  cjk: 1.5,      // CJK averages ~1.5 chars/token under BPE.
  code: 3.0,     // Code-density characters are ~3.0 chars/token.
  prose: 4.0,    // English prose default.
};

export interface TokenEstimate {
  tokens: number;
  /** Approximate breakdown of chars per class for diagnostic logging. */
  breakdown: {
    cjkChars: number;
    codeChars: number;
    proseChars: number;
  };
}

function isCjk(codePoint: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

/**
 * Estimate token count for a single string. Returns both the token
 * count and the per-class breakdown for diagnostic logging.
 *
 * The estimate is intentionally conservative — we ROUND UP each class
 * and SUM, so the total is always at least the true minimum. That's
 * the right safety profile for compaction triggering: tripping early
 * is harmless, tripping late costs a 4xx context-overflow.
 */
export function estimateTokensDetailed(text: string): TokenEstimate {
  let cjkChars = 0;
  let codeChars = 0;
  let proseChars = 0;
  if (typeof text !== 'string' || text.length === 0) {
    return { tokens: 0, breakdown: { cjkChars: 0, codeChars: 0, proseChars: 0 } };
  }
  // Iterate as code points (handles surrogate pairs correctly) — String
  // iteration yields one code point per step, not one UTF-16 unit.
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isCjk(cp)) cjkChars++;
    else if (CODE_DENSITY_CHARS.has(ch)) codeChars++;
    else proseChars++;
  }
  const tokens = Math.ceil(cjkChars / CHARS_PER_TOKEN.cjk)
    + Math.ceil(codeChars / CHARS_PER_TOKEN.code)
    + Math.ceil(proseChars / CHARS_PER_TOKEN.prose);
  return { tokens, breakdown: { cjkChars, codeChars, proseChars } };
}

/** Shorthand for `estimateTokensDetailed(text).tokens` — what most callers want. */
export function estimateTokens(text: string): number {
  return estimateTokensDetailed(text).tokens;
}

/**
 * Estimate the prompt-token cost of a chat-history array as the model
 * would actually see it (after role labels + content joining, but WITHOUT
 * the JSON syntax overhead `JSON.stringify` would add). Approximates the
 * provider's tokenizer well enough for compaction decisions.
 *
 * Each message contributes:
 *   - ~4 tokens of role/format overhead (matches OpenAI's documented
 *     "every message follows {role: ..., content: ...}" framing).
 *   - estimateTokens(content)
 *   - For assistant messages with `tool_calls`, the tool-call JSON
 *     itself is content the provider sees and tokenises.
 */
export interface ChatMessageLike {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  name?: string;
}

const PER_MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateChatHistoryTokens(messages: readonly ChatMessageLike[]): number {
  let total = 0;
  for (const m of messages) {
    total += PER_MESSAGE_OVERHEAD_TOKENS;
    if (typeof m.content === 'string') {
      total += estimateTokens(m.content);
    } else if (m.content != null) {
      // Arrays / objects (tool-result content blocks etc.) — fall back to
      // JSON length on these. They're rare and structured, so the extra
      // syntax overhead doesn't drift the count by much.
      total += estimateTokens(JSON.stringify(m.content));
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (typeof tc.function?.name === 'string') total += estimateTokens(tc.function.name);
        if (typeof tc.function?.arguments === 'string') total += estimateTokens(tc.function.arguments);
      }
    }
    if (typeof m.name === 'string' && m.name.length > 0) total += 1;
  }
  return total;
}

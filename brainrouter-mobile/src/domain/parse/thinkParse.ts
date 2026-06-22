/**
 * Model-aware reasoning extraction (T10). Several open reasoning models
 * (DeepSeek-R1, QwQ, some local Qwen/Codex setups) stream their chain-of-thought
 * INLINE at the start of the answer, wrapped in `<think>…</think>` (or
 * `<thinking>` / `<thought>` / `<reasoning>`), instead of using a separate
 * reasoning channel. Left untouched it renders as literal text in the chat. This
 * splits an assistant message into its leading reasoning block and the visible
 * answer so the renderer can tuck reasoning into a collapsible section.
 *
 * Deliberately LEADING-ONLY: real reasoning models emit the think block first,
 * then the answer. We only extract a block that begins the message (after
 * optional whitespace), so a `<think>` that appears mid-answer — e.g. inside a
 * code sample about HTML — is left exactly as written. Models that don't emit
 * these tags are unaffected: `reasoning` is empty and `visible === input`.
 * Pure + unit-tested.
 */
const TAGS = ['think', 'thinking', 'thought', 'reasoning'];
const ALT = TAGS.join('|');

export interface ParsedThink {
  /** The extracted leading reasoning text (trimmed), or '' if none. */
  reasoning: string;
  /** The answer to render, with the leading reasoning block removed. */
  visible: string;
  /** Whether a leading reasoning block was found (may still be streaming). */
  hadThink: boolean;
  /** True while the opening tag has no matching close yet (mid-stream). */
  streaming: boolean;
}

export function parseThink(text: string): ParsedThink {
  const src = text ?? '';
  // Fast path: no leading reasoning tag → return unchanged (the common case).
  if (!new RegExp(`^\\s*<(?:${ALT})>`, 'i').test(src)) {
    return { reasoning: '', visible: src, hadThink: false, streaming: false };
  }
  // Closed leading block: <think> … </think> (matching tag, case-insensitive).
  const closed = src.match(new RegExp(`^\\s*<(${ALT})>([\\s\\S]*?)<\\/\\1>`, 'i'));
  if (closed) {
    return { reasoning: closed[2].trim(), visible: src.slice(closed[0].length).trim(), hadThink: true, streaming: false };
  }
  // Unclosed: the close tag hasn't arrived yet — everything after the opening
  // tag is (still-streaming) reasoning, and there's no visible answer yet.
  const open = src.match(new RegExp(`^\\s*<(?:${ALT})>([\\s\\S]*)$`, 'i'));
  return { reasoning: (open?.[1] ?? '').trim(), visible: '', hadThink: true, streaming: true };
}

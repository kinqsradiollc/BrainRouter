/**
 * JSON truncation repair (0.3.9 item 11.3).
 *
 * When `max_tokens` cuts off mid-JSON, the tool-call `function.arguments`
 * field becomes a malformed object: unbalanced braces, an unterminated
 * string, a trailing comma. The agent's `parseArgumentsOrError()` in
 * `toolCallRecovery.ts` correctly flags the parse error — but the
 * model then has to start the call over from scratch on the next turn,
 * burning tokens.
 *
 * This pass attempts a best-effort repair before the parse:
 *
 *   - close any unterminated string by appending a `"`.
 *   - close any open `[` / `{` by appending matching closers.
 *   - drop a trailing comma immediately before a closer.
 *
 * If the repaired text parses cleanly, we hand it on to the tool. If
 * it still doesn't parse, we surface a `TRUNCATION UNRECOVERABLE` note
 * so the caller can synthesize a re-issue prompt with the model.
 *
 * Adapted from openSrc/DeepSeek-Reasonix/src/repair/truncation.ts.
 */

export interface TruncationRepairResult {
  /** The repaired text. Equal to the input when no repair was attempted. */
  repaired: string;
  /** `true` iff we actually changed the input. */
  changed: boolean;
  /** `true` iff repair failed (the model needs to re-issue). */
  fallback: boolean;
  notes: string[];
}

const MAX_REPAIR_INPUT = 256 * 1024;

export function repairTruncatedJson(input: string): TruncationRepairResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { repaired: input, changed: false, fallback: false, notes: [] };
  }
  if (input.length > MAX_REPAIR_INPUT) {
    return {
      repaired: input,
      changed: false,
      fallback: true,
      notes: [`truncation repair skipped: input too large (${input.length} chars)`],
    };
  }

  // Fast path — already parses.
  if (looksLikeCompleteJson(input)) {
    return { repaired: input, changed: false, fallback: false, notes: [] };
  }

  // Try a structural completion: close any open string, then any open
  // arrays / objects, then strip a stray trailing comma.
  let repaired = input;
  const notes: string[] = [];

  // Step 1: close an unterminated string. Walk the input tracking
  // string state; if we end inside a string, append `"`.
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < repaired.length; i++) {
    const c = repaired[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') { stack.push('}'); continue; }
    if (c === '[') { stack.push(']'); continue; }
    if (c === '}' || c === ']') {
      if (stack[stack.length - 1] === c) stack.pop();
      // Else mismatched closer — let the parser flag it; we don't try
      // to fix that case (the model would need to re-emit anyway).
    }
  }
  if (inString) {
    repaired += '"';
    notes.push('truncation repair: closed an unterminated string');
  }

  // Step 2: append matching closers for any still-open containers.
  if (stack.length > 0) {
    notes.push(`truncation repair: closed ${stack.length} open container(s) (${stack.slice().reverse().join('')})`);
    for (let i = stack.length - 1; i >= 0; i--) {
      repaired += stack[i];
    }
  }

  // Note: trailing-comma cleanup is intentionally NOT done here.
  // Pure stylistic mistakes (e.g. `{"a": 1,}` emitted by a confused
  // model) should surface to the model as a malformed-args error so it
  // self-corrects — they are not truncations. Truncation-style cuts
  // (mid-string, missing closer) get auto-repaired above.

  const changed = repaired !== input;
  if (looksLikeCompleteJson(repaired)) {
    return { repaired, changed, fallback: false, notes };
  }
  return {
    repaired: input,
    changed: false,
    fallback: true,
    notes: [...notes, 'truncation repair: structural completion did not produce parseable JSON'],
  };
}

export function looksLikeCompleteJson(s: string): boolean {
  if (!s || !s.trim()) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

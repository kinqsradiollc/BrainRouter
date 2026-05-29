// Strict tool-call recovery helpers (0.3.8-I4 / roadmap §8).
//
// Detect tool_calls that never received a paired tool_result and inject
//   synthetic placeholders so strict OpenAI-compatible validators don't
//   reject the next request.
//
// These helpers are intentionally pure (no agent.ts imports) so they can be
// unit-tested in isolation and reused if another runtime grows similar needs.

export interface ToolCallLike {
  id: string;
  type?: string;
  function: { name: string; arguments: string | object };
}

export interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  name: string;
  content: string;
  isError?: boolean;
}

/**
 * Drop duplicate tool_call ids inside a single assistant response. Keeps the
 * LAST occurrence (closest to the model's final intent). Calls without a
 * string id are passed through unchanged — the orphan safety net will catch
 * them later.
 *
 * `onDuplicate` is invoked once per dropped duplicate so callers can log a
 * warning without coupling this module to a logger.
 */
export function dedupeToolCalls<T extends ToolCallLike>(
  calls: T[] | undefined | null,
  onDuplicate?: (id: string, droppedIndex: number) => void,
): T[] {
  if (!Array.isArray(calls) || calls.length === 0) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    const id = c?.id;
    if (typeof id !== 'string' || id === '') {
      out.push(c);
      continue;
    }
    if (seen.has(id)) {
      onDuplicate?.(id, i);
      continue;
    }
    seen.add(id);
    out.push(c);
  }
  return out.reverse();
}

export interface ParsedArguments {
  args: Record<string, any>;
  /** Defined iff the LLM emitted malformed JSON; ready-to-use error string for a tool_result envelope. */
  error?: string;
  rawArguments: string;
}

/**
 * Try-parse `tool_call.function.arguments`. On parse failure return a
 * structured error string instead of throwing, so the caller can attach a
 * synthetic tool_result that the next model turn can read.
 */
export function parseArgumentsOrError(call: ToolCallLike): ParsedArguments {
  const raw = call?.function?.arguments;
  if (raw == null) return { args: {}, rawArguments: '' };
  if (typeof raw !== 'string') {
    // Provider already parsed it for us.
    return {
      args: (raw && typeof raw === 'object') ? (raw as Record<string, any>) : {},
      rawArguments: (() => { try { return JSON.stringify(raw); } catch { return String(raw); } })(),
    };
  }
  if (raw.trim() === '') return { args: {}, rawArguments: raw };
  try {
    const parsed = JSON.parse(raw);
    return {
      args: (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {},
      rawArguments: raw,
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    // Keep the raw arguments visible — the model often needs to see exactly
    // what it produced to self-correct (e.g. trailing comma, missing quote).
    const previewedRaw = raw.length > 400 ? `${raw.slice(0, 400)}…[truncated ${raw.length - 400} chars]` : raw;
    return {
      args: {},
      error: `Tool argument JSON was malformed: ${msg}. Raw arguments emitted by the model: ${previewedRaw}. Re-issue the tool call with valid JSON arguments.`,
      rawArguments: raw,
    };
  }
}

/**
 * For every tool_call in `calls` that has no matching tool_result in
 * `results`, build a synthetic tool message so the next LLM request stays
 * well-formed (OpenAI strictly requires tool_call ↔ tool_result pairing).
 *
 * IMPORTANT: the synthetic `content` MUST start with `ERROR:` and be a plain
 * string. The agent runtime's R1 child-drain guardrail tracks spawned
 * children by `parseJsonObject(resultText)` on tool results — if the
 * synthetic envelope parses as JSON with an `id` field, the guardrail would
 * incorrectly think a child agent was spawned and try to wait on it.
 */
export function synthesizeOrphanResults<T extends ToolCallLike>(
  calls: T[] | undefined | null,
  results: ToolResultMessage[],
): ToolResultMessage[] {
  if (!Array.isArray(calls) || calls.length === 0) return [];
  const have = new Set(results.map((r) => r.tool_call_id));
  const synthetic: ToolResultMessage[] = [];
  for (const c of calls) {
    const id = c?.id;
    if (typeof id !== 'string' || id === '') continue;
    if (have.has(id)) continue;
    synthetic.push({
      role: 'tool',
      tool_call_id: id,
      name: c?.function?.name ?? 'unknown',
      content: 'ERROR: tool call orphaned by model; no execution recorded. Re-issue the tool call if you still need this work done.',
      isError: true,
    });
  }
  return synthetic;
}

/**
 * Detect "stalled preamble" responses — short content that announces an
 * action ("I'll start by…", "Let me…", "Now I'll…") but isn't followed by
 * any tool_calls in the same assistant message. Smaller / weaker models
 * (Gemma 2B, free-tier OS) hit this often: they write the preamble but
 * then forget to emit the actual
 * tool_calls before yielding the turn, leaving the user staring at "I'll
 * start by exploring…" with no follow-through.
 *
 * Used by the runtime preamble guardrail in `agent.ts` — when the loop is
 * about to exit with no tool_calls AND `looksLikeStalledPreamble(content)`
 * is true AND the turn already had ≥1 tool call earlier, we inject a
 * corrective system message and continue one more iteration. Bounded by a
 * counter so a model that ONLY emits preambles can't loop forever.
 *
 * Conservative on purpose: long content (>400 chars) is assumed to have
 * substance, and the regex anchors on the START of the trimmed content so
 * legitimate replies that contain "I'll" mid-sentence aren't false-positive.
 */
export function looksLikeStalledPreamble(content: string | null | undefined): boolean {
  if (typeof content !== 'string') return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 400) return false;

  // Common preamble starters observed in the wild:
  // "Let me fetch the URL…", "Now, I will search…", "OK! Now let's…",
  // "I need to update several files here…". Anchored at start of string —
  // a sentence that begins this way and is short is overwhelmingly a
  // preamble, not a complete answer.
  const preambleStarters = [
    /^I['’]?ll\b/i,
    /^I will\b/i,
    /^I['’]?m going to\b/i,
    /^I['’]?m about to\b/i,
    /^Let me\b/i,
    /^Let['’]?s\b/i,
    /^Now,?\s+I['’]?ll\b/i,
    /^Now,?\s+I will\b/i,
    /^Now,?\s+let['’]?s\b/i,
    /^Next,?\s+I['’]?ll\b/i,
    /^Next,?\s+I will\b/i,
    /^First,?\s+I['’]?ll\b/i,
    /^First,?\s+I will\b/i,
    /^Starting\b/i,
    /^Starting by\b/i,
    /^Standby\b/i,
    /^Stand by\b/i,
    /^OK[!,.]?\s+(?:Now|Let)/i,
    // Additional preamble forms commonly emitted by open-source models.
    // Anchored at start of
    // string so legitimate mid-sentence uses don't false-positive.
    /^Looking at\b/i,
    /^Checking\b/i,
    /^Reading\b/i,
    /^Searching\b/i,
    /^Investigating\b/i,
    /^Exploring\b/i,
    /^Examining\b/i,
    /^Going to\b/i,
    /^About to\b/i,
    /^Will (?:read|check|search|run|look|explore|investigate|examine|grep|find)\b/i,
  ];
  return preambleStarters.some((re) => re.test(trimmed));
}

/**
 * Use the caller's existing `normalizeToolName` to surface a "did you mean"
 * suggestion when the LLM emits a tool name that doesn't exist as-is but
 * normalizes to a real registered tool. Tolerates the single-underscore
 * `mcp_<server>_<tool>` prefix (R5 convention) since `normalizeToolName`
 * matches by flattened form.
 */
export function suggestSimilarToolName(
  raw: string,
  candidates: string[],
  normalize: (raw: string, candidates: string[]) => string,
): string | undefined {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || candidates.includes(trimmed)) return undefined;
  const suggestion = normalize(trimmed, candidates);
  if (suggestion && suggestion !== trimmed && candidates.includes(suggestion)) {
    return suggestion;
  }
  return undefined;
}

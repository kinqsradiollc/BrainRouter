// Strict tool-call recovery helpers (0.3.8-I4 / roadmap §8).
//
// Adapted from deer-flow/backend/packages/harness/deerflow/agents/middlewares/
//   dangling_tool_call_middleware.py — same pattern: detect tool_calls that
//   never received a paired tool_result and inject synthetic placeholders so
//   strict OpenAI-compatible validators don't reject the next request.
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

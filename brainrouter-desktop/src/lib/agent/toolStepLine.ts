/**
 * Step lines for the live "thinking…" stream. A person watching a turn sees the
 * model's reasoning and any provider-side activity there; the tools BrainRouter
 * itself ran only appeared in the tool-calls panel, so the step stream read as
 * "thinking, thinking, answer" with the work invisible. These render each tool
 * call inline, in order, as one short line: what was called, with what, and how
 * it ended. Pure — formats only.
 */

const ARGS_MAX = 120;

function compactArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  const text = entries
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`)
    .join(' ');
  return text.length > ARGS_MAX ? `${text.slice(0, ARGS_MAX - 1)}…` : text;
}

/** `▸ read_file path="src/a.ts"` — appended when a tool starts (no newline: the outcome completes the line). */
export function toolStartLine(tool: string, args: unknown): string {
  const a = compactArgs(args);
  return `\n▸ ${tool}${a ? ` ${a}` : ''}`;
}

/** ` → ✓ 42 lines` / ` → ✗ Tool execution failed: …` — completes the start line. */
export function toolEndLine(ok: boolean, summary: string | undefined): string {
  const s = (summary ?? '').replace(/\s+/g, ' ').trim();
  const shown = s.length > 160 ? `${s.slice(0, 159)}…` : s;
  return ` → ${ok ? '✓' : '✗'}${shown ? ` ${shown}` : ''}\n`;
}

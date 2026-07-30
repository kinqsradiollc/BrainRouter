/**
 * CC-P2.4 — `/recap` (0.4.15 thread H). Deterministic "where was I?" summary
 * for returning to a session: what was discussed, what ran, what changed, and
 * what's still open — built purely from the persisted transcript + plan +
 * goal, no LLM call (instant, works offline). Pure → unit-tested; the command
 * layer renders the lines.
 */
import type { TranscriptEntry } from './sessionStore.js';
import type { PlanState } from '../../task/taskStore.js';

export interface RecapInput {
  entries: TranscriptEntry[];
  plan?: PlanState | null;
  goalText?: string | null;
  goalStatus?: string | null;
  sessionKey: string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n - 1) + '…';
}

function toolCallsOf(e: TranscriptEntry): Array<{ name?: string; arguments?: string }> {
  if (!Array.isArray(e.tool_calls)) return [];
  return (e.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>).map((c) => ({
    name: c?.function?.name,
    arguments: c?.function?.arguments,
  }));
}

/** Build the recap lines. Pure. */
export function buildRecap(input: RecapInput): string[] {
  const { entries } = input;
  const lines: string[] = [];

  // Exclude injected system/guard messages (role:'user' WITH a name) from the
  // prompt count + "last prompt" — they aren't things the user typed.
  const users = entries.filter((e) => e.role === 'user' && !e.name);
  const assistants = entries.filter((e) => e.role === 'assistant');
  const first = entries[0]?.timestamp?.replace('T', ' ').slice(0, 16);
  const last = entries[entries.length - 1]?.timestamp?.replace('T', ' ').slice(0, 16);

  lines.push(`Session ${input.sessionKey}`);
  lines.push(`${entries.length} entries · ${users.length} prompts${first && last ? ` · ${first} → ${last}` : ''}`);
  lines.push('');

  const lastUser = [...users].reverse().find((e) => textOf(e.content).trim());
  if (lastUser) lines.push(`Last prompt: ${clip(textOf(lastUser.content), 120)}`);
  const lastAssistant = [...assistants].reverse().find((e) => textOf(e.content).trim() && toolCallsOf(e).length === 0);
  if (lastAssistant) lines.push(`Last answer: ${clip(textOf(lastAssistant.content), 160)}`);

  // Tools used + files touched (from tool_call arguments).
  const toolCounts = new Map<string, number>();
  const files = new Set<string>();
  for (const e of entries) {
    for (const c of toolCallsOf(e)) {
      if (!c.name) continue;
      toolCounts.set(c.name, (toolCounts.get(c.name) ?? 0) + 1);
      if (/^(edit_file|write_file|read_file)$/.test(c.name) && c.arguments) {
        try {
          const p = (JSON.parse(c.arguments) as { path?: string }).path;
          if (p) files.add(`${p}${c.name === 'read_file' ? '' : ' (modified)'}`);
        } catch { /* unparseable args — skip */ }
      }
    }
  }
  if (toolCounts.size > 0) {
    const top = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([n, c]) => `${n}×${c}`).join(' · ');
    lines.push(`Tools: ${top}`);
  }
  if (files.size > 0) {
    lines.push('Files touched:');
    [...files].slice(0, 10).forEach((f) => lines.push(`  - ${f}`));
    if (files.size > 10) lines.push(`  …and ${files.size - 10} more`);
  }

  // Open work.
  const planItems = input.plan?.items ?? [];
  const open = planItems.filter((i) => i.status !== 'completed');
  if (planItems.length > 0) {
    lines.push('');
    lines.push(`Plan: ${planItems.length - open.length}/${planItems.length} done${open.length ? ` — next: ${clip(open[0].step, 100)}` : ' ✓'}`);
  }
  if (input.goalText) {
    lines.push(`Goal (${input.goalStatus ?? 'active'}): ${clip(input.goalText, 120)}`);
  }
  return lines;
}

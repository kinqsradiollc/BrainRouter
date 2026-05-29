/**
 * 0.4.x-4 — `/context` token breakdown (pure formatter, unit-tested).
 *
 * Takes a snapshot of the agent's session usage + per-skill buckets +
 * per-tool counts + briefing metrics and renders plain text lines. Kept free
 * of chalk so the output is assertable in tests; the command handler colours
 * indented rows when it prints.
 */

export interface SkillUsageRow {
  skill: string;
  promptTokens: number;
  completionTokens: number;
  turns: number;
  calls: number;
}

export interface ContextReportInput {
  /** `all` = full breakdown; `current` = only the active skill's slice (no per-tool table). */
  scope: 'all' | 'current';
  /** Active skill this turn, or null → treated as the `chat` bucket. */
  currentSkill: string | null;
  session: { promptTokens: number; completionTokens: number; turns: number; calls: number };
  bySkill: SkillUsageRow[];
  byTool: Array<{ tool: string; count: number }>;
  briefing: { tokensInjected: number; recordsConsulted: number };
  children: { count: number; promptTokens: number; completionTokens: number; calls: number };
}

function tokens(u: { promptTokens: number; completionTokens: number }): number {
  return u.promptTokens + u.completionTokens;
}

export function formatContextReport(input: ContextReportInput): string[] {
  const lines: string[] = [];
  const sessionTotal = tokens(input.session);
  const childTotal = input.children.promptTokens + input.children.completionTokens;
  const grand = sessionTotal + childTotal;

  lines.push(`Session: ${sessionTotal.toLocaleString()} tokens (${input.session.promptTokens.toLocaleString()}↑ / ${input.session.completionTokens.toLocaleString()}↓, ${input.session.turns} turns, ${input.session.calls} calls)`);
  if (input.children.count > 0) {
    lines.push(`Children (${input.children.count}): ${childTotal.toLocaleString()} tokens`);
    lines.push(`Total: ${grand.toLocaleString()} tokens`);
  }
  lines.push('');

  // ── Per-skill ──────────────────────────────────────────────────────────
  const currentKey = input.currentSkill ?? 'chat';
  const skills = input.scope === 'current'
    ? input.bySkill.filter((s) => s.skill === currentKey)
    : [...input.bySkill].sort((a, b) => tokens(b) - tokens(a));
  lines.push(input.scope === 'current' ? `By skill — current: ${currentKey}` : 'By skill');
  if (skills.length === 0) {
    lines.push('  (none yet)');
  } else {
    for (const s of skills) {
      const t = tokens(s);
      const pct = sessionTotal > 0 ? Math.round((t / sessionTotal) * 100) : 0;
      lines.push(`  ${s.skill.padEnd(26)} ${String(t.toLocaleString()).padStart(9)} tok  ${String(pct).padStart(3)}%  (${s.turns} turn${s.turns === 1 ? '' : 's'})`);
    }
  }
  lines.push('');

  // ── Per-briefing ───────────────────────────────────────────────────────
  lines.push(`Memory briefings: ${input.briefing.tokensInjected.toLocaleString()} tokens injected · ${input.briefing.recordsConsulted} records consulted`);

  // ── Per-tool (counts) — only in the full breakdown ───────────────────────
  if (input.scope === 'all') {
    lines.push('');
    const tools = [...input.byTool].sort((a, b) => b.count - a.count);
    lines.push('By tool (calls)');
    if (tools.length === 0) {
      lines.push('  (none yet)');
    } else {
      for (const t of tools.slice(0, 15)) {
        lines.push(`  ${t.tool.padEnd(26)} ${String(t.count).padStart(5)}`);
      }
      if (tools.length > 15) lines.push(`  …and ${tools.length - 15} more`);
    }
  }

  return lines;
}

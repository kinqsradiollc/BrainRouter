/**
 * CLI-6 (0.4.3) — memory-decision view for `/context memory`.
 *
 * Explains the last turn's briefing decision: what the router planned, which
 * sources it actually used, which it skipped (and why), and which memories it
 * injected. Pure (decoupled input shape, no chalk) so it unit-tests without a
 * REPL; the command handler colours the indented rows when it prints.
 */

export interface MemoryDecisionInput {
  decision: string;
  reasons: string[];
  /** Sources actually consulted. */
  sources: string[];
  /** Sources the router planned before availability checks. */
  sourcesPlanned: string[];
  skippedSources: Array<{ source: string; reason: string }>;
  recordCount: number;
  tokensInjected: number;
  charsSaved: number;
  recalled: Array<{ recordId: string; type?: string; priority?: number; content?: string }>;
}

function snippet(text: string | undefined, max = 80): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function formatMemoryDecisions(input: MemoryDecisionInput): string[] {
  const lines: string[] = [];

  lines.push(`Decision: ${input.decision}`);
  if (input.reasons.length) lines.push(`Why: ${input.reasons.join("; ")}`);
  lines.push("");

  // ── Sources: planned → used, and what was skipped ───────────────────────
  lines.push(`Sources planned: ${input.sourcesPlanned.length ? input.sourcesPlanned.join(", ") : "(none)"}`);
  lines.push(`Sources used: ${input.sources.length ? input.sources.join(", ") : "(none)"}`);
  if (input.skippedSources.length) {
    lines.push("Skipped:");
    for (const s of input.skippedSources) lines.push(`  ${s.source} — ${s.reason}`);
  } else {
    lines.push("Skipped: (none)");
  }
  lines.push("");

  // ── Injected memories ────────────────────────────────────────────────────
  lines.push(`Injected: ${input.recordCount} record${input.recordCount === 1 ? "" : "s"} · ${input.tokensInjected.toLocaleString()} tokens · saved ${input.charsSaved.toLocaleString()} chars`);
  if (input.recalled.length) {
    // Highest priority first — that's the order they earned injection.
    const sorted = [...input.recalled].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    for (const r of sorted) {
      const tag = r.type ? `[${r.type}]` : "[record]";
      const pri = r.priority != null ? ` p${r.priority}` : "";
      lines.push(`  ${tag}${pri} ${snippet(r.content)} (${r.recordId})`);
    }
  }

  return lines;
}

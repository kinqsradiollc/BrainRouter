/**
 * MEM-33b (0.4.4) — gate + summary for auto skill-extraction. After a turn the
 * CLI fire-and-forgets `memory_extract_skill` only when it looks like a real
 * multi-step procedure (enough tool calls + a substantive answer) and the knob
 * is on. Pure so the gate is testable; the brain's `<no-skill/>` gate is the
 * second line of defence (exploratory runs distil to nothing).
 */
export function shouldAutoExtractSkill(opts: {
  enabled: boolean;
  toolCalls: number;
  answerLength: number;
  minToolCalls?: number;
}): boolean {
  return opts.enabled && opts.toolCalls >= (opts.minToolCalls ?? 3) && opts.answerLength >= 40;
}

/** Compact session summary fed to memory_extract_skill (the SOP distillation input). */
export function buildSessionSummary(prompt: string, answer: string, toolCalls: number): string {
  const p = (prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const a = (answer ?? '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  return `Task: ${p}\nTool calls: ${toolCalls}\nOutcome: ${a}`;
}

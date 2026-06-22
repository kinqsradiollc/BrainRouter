/**
 * CC-P8.2 — decision-trace normalization + diff (0.4.15 thread L).
 *
 * Run the SAME task through a reference agent and through BrainRouter, then
 * diff the decision traces instead of eyeballing transcripts. A trace
 * normalizes a session into the sequence of decisions that matter for
 * behavior parity: prompts, tool BATCH shapes (which tools went out together
 * in one assistant message), and turn-ending answers (with deferral flags).
 * `diffTraces` reports the structural gaps: batching shapes, tool mix,
 * question/promise endings, step counts. Pure → unit-tested.
 */
import type { BehaviorTranscriptEntry } from './behaviorMetrics.js';

export type TraceStep =
  | { kind: 'prompt'; text: string }
  | { kind: 'batch'; tools: string[] }
  | { kind: 'answer'; endsOnQuestion: boolean; chars: number };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

/** Normalize a transcript into its decision trace. Pure. */
export function normalizeTrace(entries: BehaviorTranscriptEntry[]): TraceStep[] {
  const steps: TraceStep[] = [];
  for (const e of entries) {
    if (e.role === 'user') {
      const t = textOf(e.content).trim();
      // Guard corrections and harness reminders are runtime injections, not
      // user decisions — keep only "real" prompts (heuristic: guardrail tag).
      if (t && !/guardrail tripped|reminder:/i.test(t)) steps.push({ kind: 'prompt', text: t.slice(0, 80) });
    } else if (e.role === 'assistant') {
      const calls = Array.isArray(e.tool_calls)
        ? (e.tool_calls as Array<{ function?: { name?: string } }>).map((c) => c?.function?.name ?? 'tool')
        : [];
      if (calls.length > 0) {
        steps.push({ kind: 'batch', tools: [...calls].sort() });
      } else {
        const t = textOf(e.content).trim();
        if (t) steps.push({ kind: 'answer', endsOnQuestion: /\?\s*$/.test(t), chars: t.length });
      }
    }
  }
  return steps;
}

export interface TraceSummary {
  prompts: number;
  batches: number;
  parallelBatches: number;
  toolCalls: number;
  toolMix: Record<string, number>;
  answers: number;
  questionEndings: number;
}

/** Summarize a trace. Pure. */
export function summarizeTrace(steps: TraceStep[]): TraceSummary {
  const s: TraceSummary = { prompts: 0, batches: 0, parallelBatches: 0, toolCalls: 0, toolMix: {}, answers: 0, questionEndings: 0 };
  for (const step of steps) {
    if (step.kind === 'prompt') s.prompts += 1;
    else if (step.kind === 'batch') {
      s.batches += 1;
      if (step.tools.length >= 2) s.parallelBatches += 1;
      s.toolCalls += step.tools.length;
      for (const t of step.tools) s.toolMix[t] = (s.toolMix[t] ?? 0) + 1;
    } else {
      s.answers += 1;
      if (step.endsOnQuestion) s.questionEndings += 1;
    }
  }
  return s;
}

/** Markdown gap report between a reference trace and ours. Pure. */
export function diffTraces(reference: TraceStep[], ours: TraceStep[], labels = { a: 'reference', b: 'brainrouter' }): string {
  const A = summarizeTrace(reference);
  const B = summarizeTrace(ours);
  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : '—');
  const mixLine = (m: Record<string, number>) =>
    Object.entries(m).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join(' · ') || '—';
  const gap: string[] = [];
  if (pct(A.parallelBatches, A.batches) !== pct(B.parallelBatches, B.batches)) {
    gap.push(`- Batching: ${labels.a} parallelizes ${pct(A.parallelBatches, A.batches)} of tool messages vs ${labels.b} ${pct(B.parallelBatches, B.batches)}.`);
  }
  if (B.batches > A.batches) gap.push(`- Step count: ${labels.b} took ${B.batches - A.batches} more tool round-trips for the same task.`);
  if (B.questionEndings > A.questionEndings) gap.push(`- Deferrals: ${labels.b} ended on a question ${B.questionEndings}× vs ${A.questionEndings}×.`);
  const aTools = new Set(Object.keys(A.toolMix));
  const onlyB = Object.keys(B.toolMix).filter((t) => !aTools.has(t));
  if (onlyB.length) gap.push(`- Tool mix: only ${labels.b} used ${onlyB.join(', ')}.`);
  return [
    `# Decision-trace diff — ${labels.a} vs ${labels.b}`,
    '',
    `| Metric | ${labels.a} | ${labels.b} |`,
    '|---|---|---|',
    `| prompts | ${A.prompts} | ${B.prompts} |`,
    `| tool messages (batches) | ${A.batches} | ${B.batches} |`,
    `| parallel batches | ${A.parallelBatches} (${pct(A.parallelBatches, A.batches)}) | ${B.parallelBatches} (${pct(B.parallelBatches, B.batches)}) |`,
    `| tool calls | ${A.toolCalls} | ${B.toolCalls} |`,
    `| answers / question-endings | ${A.answers} / ${A.questionEndings} | ${B.answers} / ${B.questionEndings} |`,
    `| tool mix | ${mixLine(A.toolMix)} | ${mixLine(B.toolMix)} |`,
    '',
    gap.length ? '## Gaps\n' + gap.join('\n') : '## Gaps\n- No structural gaps detected.',
    '',
  ].join('\n');
}

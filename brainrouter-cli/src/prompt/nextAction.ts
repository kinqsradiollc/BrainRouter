/**
 * NEXT-ACTION PLANNER (0.4.7) — the system *reasons* about what to do next.
 *
 * The breadth detector (`breadthHint.ts`) only pattern-matches the prompt for
 * intensity/comparison words — a brittle keyword guess that keeps missing real
 * tasks ("who has the best cli?", "pros and cons against those") and never
 * actually decides a strategy. This planner replaces that guess with a genuine
 * reasoning step: a focused pre-flight LLM call classifies the task and returns
 * a concrete plan, which the runtime turns into a DECISIVE directive (and arms
 * the fan-out follow-through guard) instead of a soft hint.
 *
 * This module is the pure core — message builder, tolerant parser, and the
 * directive renderer. The actual LLM call + injection lives in the agent loop
 * (it owns the LLMConfig); everything here is unit-testable with no I/O.
 */

export type NextActionStrategy = 'answer-direct' | 'investigate' | 'fan-out' | 'workflow';

export interface NextActionPlan {
  strategy: NextActionStrategy;
  /** One-line rationale the planner gives for the chosen strategy. */
  reasoning: string;
  /** For fan-out/workflow: the concrete parallel subtasks (one child each). */
  subtasks: string[];
}

const VALID: ReadonlySet<string> = new Set(['answer-direct', 'investigate', 'fan-out', 'workflow']);

/**
 * Trivial prompts never warrant a planning round-trip. Greetings, very short
 * conversational turns, and obvious one-liners answer directly. Returns true
 * when the planner LLM call should be SKIPPED (caller falls back to default
 * behavior). Pure.
 */
export function shouldSkipPlanner(prompt: string): boolean {
  const t = (prompt ?? '').trim();
  if (t.length < 12) return true;
  if (/^(hi|hey|hello|thanks|thank you|yo|sup|ok|okay|cool|nice|got it|sounds good|yes|no|yep|nope)\b[.!?\s]*$/i.test(t)) return true;
  return false;
}

/** The planner system+user messages. Pure — no I/O. */
export function buildNextActionMessages(prompt: string, contextSummary?: string): Array<{ role: string; content: string }> {
  const system = [
    'You are the NEXT-ACTION PLANNER for a memory-first coding agent. Decide the single best execution STRATEGY for the user request, then stop.',
    'Reason about the TASK, not keywords. Pick exactly one strategy:',
    '- "answer-direct": you can answer from knowledge; no tools/files needed (definitions, opinions, trivial Q&A).',
    '- "investigate": the answer requires reading this workspace first (one subsystem / a few files) — sequential tool use, no child agents.',
    '- "fan-out": the task has ≥3 INDEPENDENT parts that can run in parallel (compare N projects, audit N modules, review N files) → one child agent per part.',
    '- "workflow": a multi-PHASE pipeline where later phases depend on earlier ones (research → design → implement → verify).',
    'For fan-out/workflow, list the concrete subtasks (one per independent unit of work / phase) — these become child-agent prompts. Discover targets from the workspace; never ask the user for paths you can find.',
    'Respond with ONLY minified JSON: {"strategy":"...","reasoning":"<=20 words","subtasks":["...",...]}. subtasks=[] for answer-direct/investigate.',
  ].join('\n');
  const user = contextSummary
    ? `User request:\n${prompt}\n\nWorkspace context:\n${contextSummary}`
    : `User request:\n${prompt}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Tolerant parse of the planner's JSON reply. Accepts a bare object or one
 * fenced/﻿prefixed by prose. Returns null when nothing usable is found so the
 * caller can fail open to default behavior. Pure.
 */
export function parseNextActionPlan(text: string | null | undefined): NextActionPlan | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  // Grab the first {...} block (the planner is told to emit only JSON, but
  // weaker models wrap it in prose / fences).
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let raw: any;
  try { raw = JSON.parse(match[0]); } catch { return null; }
  const strategy = String(raw?.strategy ?? '').trim().toLowerCase();
  if (!VALID.has(strategy)) return null;
  const subtasks = Array.isArray(raw?.subtasks)
    ? raw.subtasks.map((s: unknown) => String(s ?? '').trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    strategy: strategy as NextActionStrategy,
    reasoning: String(raw?.reasoning ?? '').trim().slice(0, 240),
    subtasks,
  };
}

/**
 * Whether a plan implies parallel child agents (arms the fan-out follow-through
 * guard so the model can't accept a single-thread answer).
 */
export function planWantsFanOut(plan: NextActionPlan): boolean {
  return (plan.strategy === 'fan-out' || plan.strategy === 'workflow') && plan.subtasks.length >= 2;
}

/**
 * Render the decisive directive injected into the turn for a plan. Unlike the
 * old soft "fan-out hint", this states the decided strategy and (for fan-out)
 * the concrete child prompts the model must spawn now. Returns '' for
 * answer-direct (no injection). Pure.
 */
export function nextActionDirective(plan: NextActionPlan): string {
  if (plan.strategy === 'answer-direct') return '';
  if (plan.strategy === 'investigate') {
    return [
      '## Next-action plan (decided): investigate',
      `Rationale: ${plan.reasoning}`,
      'Your FIRST action MUST be tool calls — read the relevant workspace files now (parallel `read_file`/`list_dir`/`glob_files`). Do NOT answer from memory and do NOT ask the user for paths you can discover yourself.',
    ].join('\n');
  }
  const verb = plan.strategy === 'workflow' ? 'a multi-phase workflow' : 'a parallel fan-out';
  const lines = [
    `## Next-action plan (decided): ${plan.strategy}`,
    `Rationale: ${plan.reasoning}`,
    `This task is ${verb}. Spawn one child agent per unit below — emit a SINGLE assistant message with parallel \`spawn_agents\`/\`task_agent\` calls, then \`wait_agents\`, then synthesize. Discover any paths yourself (list_dir/glob); do not ask the user.`,
    '',
    'Subtasks (one child each):',
    ...plan.subtasks.map((s, i) => `${i + 1}. ${s}`),
    '',
    'Do NOT answer single-threaded and do NOT merely offer to "go deeper if you want" — execute the fan-out and deliver the merged result this turn.',
  ];
  return lines.join('\n');
}

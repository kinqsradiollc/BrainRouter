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

import { normalizePhasePlan, type PhasePlan } from '../../orchestration/workflow/phasePlan.js';
import { adversarialLens } from '../../orchestration/lenses.js';

export type NextActionStrategy = 'answer-direct' | 'investigate' | 'fan-out' | 'workflow' | 'build';

/**
 * BUILD-LOOP P3 (0.4.12) — mirror of `cli.buildLoop`. Defined locally (not
 * imported from config) so this pure module stays free of a config dependency;
 * the agent loop maps the resolved knob to this union when it calls the planner.
 */
export type BuildLoopMode = 'off' | 'escalate' | 'always';

export interface NextActionPlan {
  strategy: NextActionStrategy;
  /** One-line rationale the planner gives for the chosen strategy. */
  reasoning: string;
  /** For fan-out/workflow: the concrete parallel subtasks (one child each). For
   *  "build": a single refined task statement in subtasks[0] (the loop's input). */
  subtasks: string[];
  /** WF-PLANNER (0.4.8) — when strategy='workflow' and the planner produced a
   *  VALID PhasePlan, the prepared plan the runtime tells the model to hand to
   *  `run_workflow` (one call). Absent when the planner gave no usable plan. */
  phasePlan?: PhasePlan;
}

const VALID: ReadonlySet<string> = new Set(['answer-direct', 'investigate', 'fan-out', 'workflow', 'build']);

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

/** The planner system+user messages. Pure — no I/O.
 *
 *  BUILD-LOOP P3 — when `buildLoop` is enabled the planner is ALSO offered a
 *  "build" strategy (route a code-writing task into the build loop). The
 *  threshold scales with the mode: `escalate` reserves it for multi-file /
 *  feature-scale changes; `always` offers it for any implementation. `off`
 *  (default) never mentions it, so the four-strategy behavior is unchanged. */
export function buildNextActionMessages(
  prompt: string,
  contextSummary?: string,
  buildLoop: BuildLoopMode = 'off',
): Array<{ role: string; content: string }> {
  const lines = [
    'You are the NEXT-ACTION PLANNER for a memory-first coding agent. Decide the single best execution STRATEGY for the user request, then stop.',
    'Reason about the TASK, not keywords. Pick exactly one strategy:',
    '- "answer-direct": you can answer from knowledge; no tools/files needed (definitions, opinions, trivial Q&A).',
    '- "investigate": the answer requires reading this workspace first (one subsystem / a few files) — sequential tool use, no child agents.',
    '- "fan-out": the task has ≥3 INDEPENDENT parts that can run in parallel (compare N projects, audit N modules, review N files) → one child agent per part.',
    '- "workflow": a multi-PHASE pipeline where later phases depend on earlier ones (research → design → implement → verify).',
  ];
  if (buildLoop !== 'off') {
    lines.push(
      buildLoop === 'always'
        ? '- "build": the request is to WRITE code — implement / add / fix / refactor ANYTHING in this workspace (any size). Routes to the plan→implement→verify→review→merge build loop on an isolated worktree. Prefer this over "investigate" whenever the task changes code.'
        : '- "build": the request is to WRITE code — implement / add / fix / refactor a change that spans MULTIPLE files or is feature-scale and needs verification + review. Routes to the plan→implement→verify→review→merge build loop on an isolated worktree. A trivial single-file edit stays "investigate" (just do it inline).',
    );
  }
  lines.push(
    'For fan-out/workflow, list the concrete subtasks (one per independent unit of work / phase) — these become child-agent prompts. Discover targets from the workspace; never ask the user for paths you can find.',
  );
  if (buildLoop !== 'off') {
    lines.push('For "build", put ONE refined task statement in subtasks (a single element restating exactly what to implement) — no phasePlan; the loop builds its own phases.');
  }
  lines.push(
    'For "workflow" ONLY, ALSO emit a `phasePlan` the runtime can execute directly. Shape: {"title":"...","phases":[{"id":"...","title":"...","fanOut":{"over":["t1","t2"],"agent":{"role":"reviewer","prompt":"... {{target}} ..."}},"synthesize":"role-rollup"},{"id":"synth","agents":[{"role":"architect","prompt":"... {{input}} ..."}],"inputFrom":["<earlier phase id>"],"dependsOn":["<earlier phase id>"]}]}. Each phase has EITHER fanOut (one child per target, {{target}} substituted) OR agents; a later phase reads an earlier one via inputFrom ({{input}} substituted). Omit phasePlan if you are not confident.',
    'Respond with ONLY minified JSON: {"strategy":"...","reasoning":"<=20 words","subtasks":["...",...],"phasePlan":{...}}. subtasks=[] and no phasePlan for answer-direct/investigate.',
  );
  const system = lines.join('\n');
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
export function parseNextActionPlan(
  text: string | null | undefined,
  opts?: { buildLoop?: BuildLoopMode },
): NextActionPlan | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  // Grab the first {...} block (the planner is told to emit only JSON, but
  // weaker models wrap it in prose / fences).
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let raw: any;
  try { raw = JSON.parse(match[0]); } catch { return null; }
  let strategy = String(raw?.strategy ?? '').trim().toLowerCase();
  if (!VALID.has(strategy)) return null;
  // BUILD-LOOP P3 — defense in depth: if the model picks "build" while the knob
  // is off (it was never offered, but weaker models improvise), downgrade to a
  // single-thread "investigate" so the loop only ever runs when enabled.
  if (strategy === 'build' && (opts?.buildLoop ?? 'off') === 'off') strategy = 'investigate';
  const parsedSubtasks = Array.isArray(raw?.subtasks)
    ? raw.subtasks.map((s: unknown) => String(s ?? '').trim()).filter(Boolean).slice(0, 8)
    : [];
  // CONTRACT: answer-direct / investigate carry NO subtasks (the planner is told
  // "subtasks=[] for answer-direct/investigate"). Enforce it here so a stray
  // model-emitted list — or a build→investigate downgrade above — can't leak a
  // task into a single-thread strategy (which would mislabel it "investigate (1 subtasks)").
  const subtasks = strategy === 'investigate' || strategy === 'answer-direct' ? [] : parsedSubtasks;
  const plan: NextActionPlan = {
    strategy: strategy as NextActionStrategy,
    reasoning: String(raw?.reasoning ?? '').trim().slice(0, 240),
    subtasks,
  };
  // WF-PLANNER — when the planner proposed a workflow plan, validate it and
  // attach only if it passes normalizePhasePlan; otherwise fall back to the
  // subtasks directive (the planner's plan was unusable).
  if (plan.strategy === 'workflow' && raw?.phasePlan && typeof raw.phasePlan === 'object') {
    const { plan: phasePlan } = normalizePhasePlan(raw.phasePlan);
    if (phasePlan) plan.phasePlan = phasePlan;
  }
  return plan;
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
  // BUILD-LOOP P3 — a code-writing task the planner escalated into the build
  // loop. Tell the model to fire it in ONE `run_workflow` call with the `build`
  // template; the runtime plans → implements on an isolated worktree → verifies
  // → reviews the diff (the verify-green/review-approve merge GATE lands with P2).
  if (plan.strategy === 'build') {
    const task = plan.subtasks[0]?.trim();
    const argsJson = JSON.stringify({ template: 'build', templateArgs: { task: task || '<the user request above, restated as one concrete implementation task>' } });
    return [
      '## Next-action plan (decided): build',
      `Rationale: ${plan.reasoning}`,
      'This is a code-implementation task. Your FIRST action MUST be a SINGLE `run_workflow` call that runs the BUILD LOOP (plan → implement → verify → review, on isolated worktrees) — do NOT hand-edit files directly and do NOT answer single-threaded:',
      '',
      '```json',
      argsJson,
      '```',
      '',
      task
        ? 'The runtime plans the change, implements it on an isolated worktree, verifies (build + tests), and reviews the full diff. After it returns, summarize what changed and the verify/review outcome.'
        : 'Replace the `task` placeholder with one concrete sentence describing exactly what to implement (from the user request). The runtime then plans → implements on an isolated worktree → verifies → reviews. After it returns, summarize what changed and the verify/review outcome.',
    ].join('\n');
  }
  // WF-PLANNER — the planner prepared a validated PhasePlan: tell the model to
  // fire it in ONE run_workflow call (the runtime fans out / waits / synthesizes
  // / feeds forward), rather than hand-orchestrating spawn/wait/synthesize.
  if (plan.strategy === 'workflow' && plan.phasePlan) {
    return [
      '## Next-action plan (decided): workflow',
      `Rationale: ${plan.reasoning}`,
      'A multi-phase workflow plan has been PREPARED. Your FIRST action MUST be a SINGLE `run_workflow` call with this exact plan — do not spawn agents manually, do not answer single-threaded:',
      '',
      '```json',
      JSON.stringify({ plan: plan.phasePlan }),
      '```',
      '',
      'The runtime executes every phase (fan-out → wait → synthesize → feed forward). After it returns, deliver the merged result.',
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
    `Give each child a \`label\` naming its distinct angle and tell it to ignore findings outside that angle, then add one more child briefed to ${adversarialLens()}. Your synthesis must say what that child failed to break.`,
    'Do NOT answer single-threaded and do NOT merely offer to "go deeper if you want" — execute the fan-out and deliver the merged result this turn.',
  ];
  return lines.join('\n');
}

/**
 * WF-ENGINE (0.4.8) — the deterministic multi-phase workflow executor.
 *
 * Given a validated `PhasePlan` (see `phasePlan.ts`), the RUNTIME drives the
 * whole thing: for each phase in dependency order it expands the phase's agents,
 * spawns them through an injected `PhaseRunner`, **barrier-waits the entire
 * phase**, synthesizes the children's outputs, and feeds that synthesis forward
 * as `{{input}}` into the phases that declared `inputFrom`. The model does not
 * orchestrate turn-by-turn — it (or the planner) hands over a plan once and the
 * engine executes every step.
 *
 * The spawn backend is **injected** (`PhaseRunner`) so this orchestration logic
 * is fully unit-testable without an LLM: the real runner — which wires the
 * existing `handleSpawnBatch`/`handleWaitBatch` chokepoint in `maxConcurrentChildren`
 * waves — is supplied by WF-TOOL, where `run_workflow` exercises it end-to-end.
 *
 * Pure-ish: no I/O of its own; all side effects flow through the runner + hooks.
 */

import {
  type PhasePlan,
  type WorkflowPhase,
  type PhaseAgentSpec,
  expandPhaseAgents,
  phaseExecutionOrder,
  renderPrompt,
} from './phasePlan.js';
import { synthesizePhase, type SynthChild, type SynthesisRollup } from './synthesis.js';
import type { ReviewSynthesis } from '../../review/reviewSynthesis.js';

const PHASE_OUTPUT_SEP = '\n\n---\n\n';

/** One spawned child's result, as the runner reports it back to the engine. */
export interface PhaseChildResult {
  id: string;
  role: string;
  /** `completed` | `failed` | `timeout` | … (anything non-`completed`/non-empty `error` counts as failed). */
  status: string;
  finalOutput?: string;
  error?: string;
  label?: string;
  /** MAS-READMANIFEST (B2) — files this child actually read, so a downstream
   *  phase can read DELTAS instead of re-mapping the whole tree cold. */
  filesRead?: string[];
}

/**
 * MAS-READMANIFEST (B2/C3) — render the "files already mapped by prior phases"
 * block, so downstream agents (steered by PRIOR_WORK_PREAMBLE) read only what
 * they must change, not what a sibling already mapped. Each line attributes the
 * file to the phase/role that read it (C3 read-ownership). Pure.
 */
export function renderReadManifest(mapped: Map<string, Set<string>>, max = 60): string {
  if (mapped.size === 0) return '';
  const lines = [...mapped.entries()]
    .slice(0, max)
    .map(([file, by]) => `- ${file} — read by ${[...by].join(', ')}`);
  const more = mapped.size > max ? `\n…and ${mapped.size - max} more.` : '';
  return [
    '\n\n## Files already mapped by prior phases (read these only if you must change/verify them — do NOT re-read to re-derive)',
    ...lines,
  ].join('\n') + more;
}

/**
 * Spawns one phase's agents and resolves once ALL of them have finished (the
 * barrier). Injected so the engine is testable; the production runner wires
 * `handleSpawnBatch` + `handleWaitBatch` (chunked by `cli.maxConcurrentChildren`).
 * A runner that throws fails the phase (the engine records it and continues).
 */
export type PhaseRunner = (agents: PhaseAgentSpec[], phase: WorkflowPhase) => Promise<PhaseChildResult[]>;

export type PhaseStatus = 'completed' | 'partial' | 'failed';

export interface PhaseExecution {
  id: string;
  title: string;
  status: PhaseStatus;
  children: PhaseChildResult[];
  /** Present when the phase synthesized (`synthesize !== 'none'`). */
  rollup?: SynthesisRollup;
  /** Present for a `review-merge` phase that merged structured findings. */
  review?: ReviewSynthesis;
  /** The phase's aggregated output — fed as `{{input}}` into downstream phases. */
  output: string;
}

export interface PhasePlanExecution {
  title?: string;
  status: PhaseStatus;
  phases: PhaseExecution[];
}

export interface ExecuteHooks {
  onPhaseStart?: (phase: WorkflowPhase, index: number, total: number) => void;
  onPhaseComplete?: (execution: PhaseExecution) => void;
  /** WS6 — when this aborts (a user Stop), executePhasePlan stops dispatching
   *  further phases. In-flight phases' children/workers are interrupted via the
   *  agent registry; this halts the loop so no NEW phase starts. */
  signal?: AbortSignal;
}

/**
 * WF-RESUME — resume context for re-running an interrupted plan: phases already
 * `completed` are skipped (not re-spawned), and their persisted outputs are
 * pre-seeded so a downstream phase's `{{input}}` still resolves.
 */
export interface ResumeState {
  completed: Set<string>;
  priorOutputs: Map<string, string>;
}

function phaseStatus(children: PhaseChildResult[]): PhaseStatus {
  if (children.length === 0) return 'failed';
  const failed = children.filter((c) => c.status !== 'completed' || Boolean(c.error)).length;
  if (failed === 0) return 'completed';
  if (failed === children.length) return 'failed';
  return 'partial';
}

function aggregateOutput(phase: WorkflowPhase, children: PhaseChildResult[]): {
  output: string;
  rollup?: SynthesisRollup;
  review?: ReviewSynthesis;
} {
  // WF-SYNTH — delegate to the typed phase aggregator: none → concat,
  // role-rollup → contract digest, review-merge → dedupe/threshold findings
  // (falling back to role-rollup when no structured findings are present).
  const synthChildren: SynthChild[] = children.map((c) => ({
    id: c.id,
    role: c.role,
    status: c.status,
    finalOutput: c.finalOutput,
    error: c.error,
  }));
  const po = synthesizePhase(synthChildren, phase.synthesize ?? 'none');
  return { output: po.text, rollup: po.rollup, review: po.review };
}

/**
 * Execute a validated `PhasePlan`. Phases run in `dependsOn` (topological) order;
 * each phase fully completes (barrier) before the next begins, and a phase's
 * synthesized output is injected as `{{input}}` into every phase that named it in
 * `inputFrom`. Child-level failures are recorded and the run continues
 * (continue-on-failure): a phase with some failures is `partial`, all-failed is
 * `failed`, and the plan's status is the worst of its phases.
 */
export async function executePhasePlan(
  plan: PhasePlan,
  runner: PhaseRunner,
  hooks: ExecuteHooks = {},
  resume?: ResumeState,
): Promise<PhasePlanExecution> {
  const order = phaseExecutionOrder(plan);
  const outputs = new Map<string, string>();
  // WF-RESUME — pre-seed completed phases' outputs so downstream {{input}} resolves.
  if (resume) for (const [id, out] of resume.priorOutputs) outputs.set(id, out);
  const executions: PhaseExecution[] = [];
  // MAS-READMANIFEST — file path → set of "phaseId(role)" that read it, accrued
  // across phases and injected into each subsequent phase's prompts.
  const filesMapped = new Map<string, Set<string>>();
  let aborted = false; // WS6 — set when a Stop halts the run mid-plan

  for (let i = 0; i < order.length; i++) {
    const phase = order[i];
    // WS6 — a user Stop aborts the signal; halt before dispatching the next
    // phase. The in-flight phase (if any) already returned because its
    // children/workers were interrupted via the agent registry.
    if (hooks.signal?.aborted) { aborted = true; break; }
    // WF-RESUME — a phase already completed in a prior run is recorded as done
    // (with its persisted output) and NOT re-spawned.
    if (resume?.completed.has(phase.id)) {
      executions.push({
        id: phase.id,
        title: phase.title,
        status: 'completed',
        children: [],
        output: outputs.get(phase.id) ?? '',
      });
      continue;
    }
    hooks.onPhaseStart?.(phase, i, order.length);

    // Build {{input}} from the synthesized output of the phases this one consumes.
    const input = (phase.inputFrom ?? [])
      .map((id) => outputs.get(id))
      .filter((o): o is string => Boolean(o))
      .join(PHASE_OUTPUT_SEP);

    // Expand the phase into concrete agents, then inject {{input}} + the
    // accrued read-manifest into each prompt so they read deltas, not the tree.
    const manifest = renderReadManifest(filesMapped);
    const agents: PhaseAgentSpec[] = expandPhaseAgents(phase).map((a) => ({
      ...a,
      prompt: renderPrompt(a.prompt, { input }) + manifest,
    }));

    let children: PhaseChildResult[];
    try {
      children = await runner(agents, phase);
    } catch (err) {
      // Runner-level failure (e.g. spawn refused) → mark every agent failed; the
      // run continues so a later independent phase still gets its chance.
      const message = err instanceof Error ? err.message : String(err);
      children = agents.map((a, j) => ({
        id: `${phase.id}-spawn-error-${j}`,
        role: a.role ?? 'worker',
        status: 'failed',
        error: message,
        label: a.label,
      }));
    }

    const { output, rollup, review } = aggregateOutput(phase, children);
    outputs.set(phase.id, output);

    const execution: PhaseExecution = {
      id: phase.id,
      title: phase.title,
      status: phaseStatus(children),
      children,
      rollup,
      review,
      output,
    };
    executions.push(execution);
    // MAS-READMANIFEST — accrue the files this phase's children read, attributed
    // to "phaseId(role)", for the next phase's manifest (C3 read-ownership).
    for (const c of children) {
      for (const f of c.filesRead ?? []) {
        (filesMapped.get(f) ?? filesMapped.set(f, new Set()).get(f)!).add(`${phase.id}(${c.role})`);
      }
    }
    hooks.onPhaseComplete?.(execution);
  }

  const status: PhaseStatus = aborted || executions.some((p) => p.status === 'failed')
    ? 'failed' // WS6 — an interrupted run is not "completed"
    : executions.some((p) => p.status === 'partial')
      ? 'partial'
      : 'completed';

  return { title: plan.title, status, phases: executions };
}

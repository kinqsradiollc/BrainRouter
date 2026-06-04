/**
 * WF-TOOL (0.4.8) — the `run_workflow` handler that makes the PhasePlan engine
 * live end-to-end.
 *
 * The model (or, later, the next-action planner) hands over a `PhasePlan` in ONE
 * call; this seeds a durable phase run (WF-PERSIST), executes it deterministically
 * (WF-ENGINE), and reports a compact summary. The real spawn backend
 * (`defaultPhaseRunner`) drives the existing `spawn_agents` → `wait_agents`
 * chokepoint in `cli.maxConcurrentChildren`-sized waves (so the spawn-slot cap is
 * respected), via an INJECTED dispatch fn — that keeps this module free of a
 * runtime import cycle with `tools.ts` and keeps the handler unit-testable with a
 * fake runner.
 */

import type { OrchestrationContext } from './tools.js';
import { normalizePhasePlan, type PhasePlan } from './phasePlan.js';
import { buildTemplatePlan } from './workflowTemplates.js';
import {
  executePhasePlan,
  type PhaseRunner,
  type PhaseChildResult,
  type PhaseStatus,
  type PhaseExecution,
  type PhasePlanExecution,
} from './phaseOrchestrator.js';
import { ensurePhaseRun, advanceRunPhase, finishRun, readRun, type RunPhaseStatus } from '../state/workflowRun.js';
import { getCliKnobs } from '../config/config.js';
import { prepareSharedWorktree, worktreePatchFile } from './worktreeIsolation.js';
import { finalizeBuildLoop, finalizeFanOutBuild, type FanOutSlice } from './buildLoop.js';

/** The orchestration tool dispatcher (`executeOrchestrationTool`), injected to
 *  avoid a circular import and to let tests substitute a fake. */
export type OrchestrationDispatch = (name: string, args: unknown, ctx: OrchestrationContext) => Promise<string>;

/** Pure: split `items` into consecutive waves of at most `cap` (cap ≥ 1). */
export function chunkIntoWaves<T>(items: T[], cap: number): T[][] {
  const size = Math.max(1, Math.floor(cap));
  const waves: T[][] = [];
  for (let i = 0; i < items.length; i += size) waves.push(items.slice(i, i + size));
  return waves;
}

/** Slugify a workflow title/id into a filesystem-safe run slug. */
export function workflowSlug(args: { slug?: unknown }, plan: PhasePlan): string {
  const raw =
    (typeof args.slug === 'string' && args.slug.trim()) ||
    (plan.title && plan.title.trim()) ||
    'workflow';
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'workflow';
}

/**
 * The production `PhaseRunner`: for each wave (≤ cap), spawn the wave via
 * `spawn_agents`, collect the child ids, drain them via `wait_agents`, and map
 * the results to `PhaseChildResult[]`. A spawn/wait that returns no usable result
 * is recorded as a failed child (the engine then marks the phase partial/failed).
 */
export function defaultPhaseRunner(
  ctx: OrchestrationContext,
  dispatch: OrchestrationDispatch,
  maxConcurrent: number,
  opts?: { workspaceRootOverride?: string; holdWorktree?: boolean },
): PhaseRunner {
  return async (agents, phase) => {
    const results: PhaseChildResult[] = [];
    let idx = 0;
    for (const wave of chunkIntoWaves(agents, maxConcurrent)) {
      const spawnArgs = {
        // BUILD-LOOP P2 — every phase child runs in the shared worktree when set,
        // so verify/review operate on the worker's actual edits.
        // BUILD-LOOP P2.5 — a fan-out build holds each slice worker's own worktree
        // (no auto-merge) so the synthesis gate + finalize own the merge decision.
        agents: wave.map((a) => ({
          role: a.role, prompt: a.prompt, access: a.access, label: a.label,
          ...(opts?.workspaceRootOverride ? { workspaceRootOverride: opts.workspaceRootOverride } : {}),
          ...(opts?.holdWorktree ? { holdWorktree: true } : {}),
        })),
      };
      let ids: string[] = [];
      try {
        const parsed = JSON.parse(await dispatch('spawn_agents', spawnArgs, ctx)) as {
          agents?: Array<{ id?: string }>;
        };
        ids = (parsed.agents ?? []).map((x) => x.id).filter((id): id is string => Boolean(id));
      } catch {
        ids = [];
      }
      if (ids.length === 0) {
        results.push(
          ...wave.map((a, j) => ({
            id: `${phase.id}-spawn-fail-${idx + j}`,
            role: a.role ?? 'worker',
            status: 'failed',
            error: 'spawn_agents returned no child id',
            label: a.label,
          })),
        );
        idx += wave.length;
        continue;
      }
      try {
        const parsed = JSON.parse(await dispatch('wait_agents', { ids }, ctx)) as {
          agents?: Array<Record<string, unknown>>;
        };
        for (const a of parsed.agents ?? []) {
          results.push({
            id: String(a.id ?? '?'),
            role: String(a.role ?? 'worker'),
            status: String(a.status ?? 'completed'),
            finalOutput: typeof a.finalOutput === 'string' ? a.finalOutput : undefined,
            error: typeof a.error === 'string' ? a.error : undefined,
          });
        }
      } catch {
        results.push(...ids.map((id) => ({ id, role: 'worker', status: 'failed', error: 'wait_agents parse failed' })));
      }
      idx += wave.length;
    }
    return results;
  };
}

/** BUILD-LOOP P2.5 — the held slice worktrees of a fan-out build's `implement`
 *  phase: each child's id + its preserved recovery patch, for the synthesis gate. */
function collectFanOutSlices(ws: string, execution: PhasePlanExecution): FanOutSlice[] {
  const implement = execution.phases.find((p) => p.id === 'implement');
  if (!implement) return [];
  return implement.children.map((c) => ({ id: c.id, label: c.label, patchPath: worktreePatchFile(ws, c.id) }));
}

/** The synthesis `review` phase's aggregated output (drives the blocker verdict). */
function reviewPhaseOutput(execution: PhasePlanExecution): string {
  return execution.phases.find((p) => p.id === 'review')?.output ?? '';
}

const PHASE_TO_RUN_STATUS: Record<PhaseStatus, RunPhaseStatus> = {
  completed: 'completed',
  partial: 'partial',
  failed: 'failed',
};

export interface RunWorkflowDeps {
  /** The orchestration dispatcher (tools.ts passes `executeOrchestrationTool`). */
  dispatch: OrchestrationDispatch;
  /** Override the spawn backend (tests inject a fake; production uses `defaultPhaseRunner`). */
  runner?: PhaseRunner;
}

/**
 * `run_workflow({ plan, slug? })` — validate the plan, seed a durable phase run,
 * execute it deterministically (each phase persisted via the engine's hooks), and
 * return a compact JSON summary. Returns `{ ok:false, ... }` on an invalid plan.
 */
export async function runWorkflow(
  args: { plan?: unknown; slug?: unknown; template?: unknown; templateArgs?: unknown; background?: unknown; resume?: unknown },
  ctx: OrchestrationContext,
  deps: RunWorkflowDeps,
): Promise<string> {
  // WF-RESUME — resume an interrupted run from its failed/interrupted phase.
  if (typeof args?.resume === 'string' && args.resume.trim()) {
    return resumeWorkflow(args.resume.trim(), ctx, deps);
  }
  // Plan source: an explicit `plan`, or a built-in `template` + `templateArgs`
  // (WF-TEMPLATES). Either way it's validated by normalizePhasePlan below.
  let rawPlan = args?.plan;
  if (!rawPlan && typeof args?.template === 'string') {
    const built = buildTemplatePlan(args.template, args.templateArgs ?? {});
    if (!built.plan) {
      return JSON.stringify({ ok: false, error: `template "${args.template}" failed`, details: built.errors }, null, 2);
    }
    rawPlan = built.plan;
  }
  const { plan, errors } = normalizePhasePlan(rawPlan);
  if (!plan) {
    return JSON.stringify({ ok: false, error: 'invalid workflow plan', details: errors }, null, 2);
  }

  const slug = workflowSlug(args, plan);
  const ws = ctx.workspaceRoot;
  // BUILD-LOOP P2/P2.5 — a synchronous `build` run is gated. Two shapes:
  //  • single-worktree (P2): implement/verify/review share ONE worktree, merged
  //    back gated on verify-green + review-ok (`finalizeBuildLoop`).
  //  • fan-out (P2.5): the implement phase fans out one worker per slice, each in
  //    its OWN held worktree; a synthesis review reads the combined change-set, then
  //    `finalizeFanOutBuild` does the overlap-aware gated merge.
  // (Both skipped for background runs / a test-injected runner.) Tagging the run
  // `kind:'build'` lets WF-RESUME re-attach the same gate.
  const isBuildRun = args?.template === 'build' && !deps.runner && args?.background !== true;
  const isFanOutBuild = isBuildRun && !!plan.phases.find((p) => p.id === 'implement')?.fanOut;
  ensurePhaseRun(
    ws,
    slug,
    plan.phases.map((p) => ({ id: p.id, title: p.title })),
    { sessionKey: ctx.parentSessionKey ?? null, pid: process.pid, kind: isBuildRun ? 'build' : 'workflow', planJson: JSON.stringify(plan) },
  );

  const buildLoop = isBuildRun && !isFanOutBuild ? prepareSharedWorktree(ws, slug) : null;

  const runner =
    deps.runner ?? defaultPhaseRunner(
      ctx,
      deps.dispatch,
      getCliKnobs().maxConcurrentChildren ?? 8,
      buildLoop ? { workspaceRootOverride: buildLoop.workspaceRoot } : isFanOutBuild ? { holdWorktree: true } : undefined,
    );

  const hooks = makeRunHooks(ws, slug);

  // WF-BG — background mode: kick the run off DETACHED so a long fan-out doesn't
  // block the REPL turn. The durable ledger (visible via /workflows + the bg
  // panel) tracks live phase progress; the run continues in-process. On an
  // unexpected throw, the ledger is marked failed.
  if (args?.background === true) {
    void executePhasePlan(plan, runner, hooks).catch(() => {
      finishRun(ws, slug, 'failed');
    });
    return JSON.stringify(
      {
        ok: true,
        slug,
        background: true,
        status: 'running',
        phases: plan.phases.map((p) => ({ id: p.id, status: 'pending', children: 0 })),
        note: `Workflow "${slug}" started in the background — track it with \`/workflows ${slug}\` or the background panel.`,
      },
      null,
      2,
    );
  }

  const execution = await executePhasePlan(plan, runner, hooks);

  // BUILD-LOOP P2 — gate + merge the shared worktree (or preserve it as a patch).
  const buildMerge = buildLoop ? finalizeBuildLoop(ws, slug, buildLoop, execution) : undefined;
  // BUILD-LOOP P2.5 — fan-out: cross-worktree synthesis gate over the held slices.
  const fanOutMerge = isFanOutBuild ? finalizeFanOutBuild(ws, collectFanOutSlices(ws, execution), reviewPhaseOutput(execution)) : undefined;

  return JSON.stringify(
    {
      ok: true,
      slug,
      status: execution.status,
      phases: execution.phases.map((p) => ({ id: p.id, status: p.status, children: p.children.length })),
      output: execution.phases[execution.phases.length - 1]?.output ?? '',
      ...(buildMerge ? { buildMerge } : {}),
      ...(fanOutMerge ? { fanOutMerge } : {}),
    },
    null,
    2,
  );
}

const MAX_PERSISTED_OUTPUT = 8000;

/** Shared run hooks: advance the durable ledger as phases start/finish, persisting
 *  each phase's (bounded) synthesized output so WF-RESUME can feed it forward. */
function makeRunHooks(ws: string, slug: string): {
  onPhaseStart: (phase: { id: string }) => void;
  onPhaseComplete: (exec: PhaseExecution) => void;
} {
  return {
    onPhaseStart: (phase) => {
      advanceRunPhase(ws, slug, phase.id, 'running');
    },
    onPhaseComplete: (exec) => {
      advanceRunPhase(ws, slug, exec.id, PHASE_TO_RUN_STATUS[exec.status], {
        childIds: exec.children.map((c) => c.id),
        aggregatedOutputRef: exec.output.slice(0, MAX_PERSISTED_OUTPUT),
      });
    },
  };
}

/**
 * WF-RESUME — re-load an interrupted run from disk and continue from its
 * failed/interrupted phase. Completed (and partial) phases are skipped and their
 * persisted output feeds `{{input}}`; the remaining phases re-run.
 */
export async function resumeWorkflow(slug: string, ctx: OrchestrationContext, deps: RunWorkflowDeps): Promise<string> {
  const ws = ctx.workspaceRoot;
  const run = readRun(ws, slug);
  if (!run) {
    return JSON.stringify({ ok: false, error: `no workflow run "${slug}" to resume` }, null, 2);
  }
  if (!run.planJson) {
    return JSON.stringify({ ok: false, error: `run "${slug}" has no persisted plan (started before WF-RESUME) — cannot resume` }, null, 2);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(run.planJson);
  } catch {
    /* invalid JSON falls through to the unparseable error below */
  }
  const { plan } = normalizePhasePlan(parsed);
  if (!plan) {
    return JSON.stringify({ ok: false, error: `run "${slug}" plan is unparseable` }, null, 2);
  }

  // Completed/partial phases are done — skip them + feed their persisted output forward.
  const completed = new Set<string>();
  const priorOutputs = new Map<string, string>();
  for (const p of run.phases ?? []) {
    if (p.status === 'completed' || p.status === 'partial') {
      completed.add(p.id);
      if (p.aggregatedOutputRef) priorOutputs.set(p.id, p.aggregatedOutputRef);
    }
  }
  const totalPhases = run.phases?.length ?? 0;
  if (totalPhases > 0 && completed.size >= totalPhases) {
    return JSON.stringify({ ok: true, slug, resumed: false, status: 'completed', note: 'nothing to resume — all phases already completed' }, null, 2);
  }

  // BUILD-LOOP P2/P2.5 — a resumed `build` run re-attaches its gate (mirroring the
  // fresh path) so re-run phases stay isolated and nothing merges back ungated:
  // single-worktree → shared worktree + finalizeBuildLoop; fan-out → held slices +
  // finalizeFanOutBuild. (A test-injected runner skips it.)
  const isBuildResume = run.kind === 'build' && !deps.runner;
  const isFanOutBuild = isBuildResume && !!plan.phases.find((p) => p.id === 'implement')?.fanOut;
  const buildLoop = isBuildResume && !isFanOutBuild ? prepareSharedWorktree(ws, slug) : null;
  const runner = deps.runner ?? defaultPhaseRunner(
    ctx,
    deps.dispatch,
    getCliKnobs().maxConcurrentChildren ?? 8,
    buildLoop ? { workspaceRootOverride: buildLoop.workspaceRoot } : isFanOutBuild ? { holdWorktree: true } : undefined,
  );
  const execution = await executePhasePlan(plan, runner, makeRunHooks(ws, slug), { completed, priorOutputs });
  const buildMerge = buildLoop ? finalizeBuildLoop(ws, slug, buildLoop, execution) : undefined;
  const fanOutMerge = isFanOutBuild ? finalizeFanOutBuild(ws, collectFanOutSlices(ws, execution), reviewPhaseOutput(execution)) : undefined;
  return JSON.stringify(
    {
      ok: true,
      slug,
      resumed: true,
      status: execution.status,
      skipped: [...completed],
      phases: execution.phases.map((p) => ({ id: p.id, status: p.status, children: p.children.length })),
      output: execution.phases[execution.phases.length - 1]?.output ?? '',
      ...(buildMerge ? { buildMerge } : {}),
      ...(fanOutMerge ? { fanOutMerge } : {}),
    },
    null,
    2,
  );
}

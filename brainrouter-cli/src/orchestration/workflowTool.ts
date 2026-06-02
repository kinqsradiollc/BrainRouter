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
import {
  executePhasePlan,
  type PhaseRunner,
  type PhaseChildResult,
  type PhaseStatus,
} from './phaseOrchestrator.js';
import { ensurePhaseRun, advanceRunPhase, type RunPhaseStatus } from '../state/workflowRun.js';
import { getCliKnobs } from '../config/config.js';

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
): PhaseRunner {
  return async (agents, phase) => {
    const results: PhaseChildResult[] = [];
    let idx = 0;
    for (const wave of chunkIntoWaves(agents, maxConcurrent)) {
      const spawnArgs = {
        agents: wave.map((a) => ({ role: a.role, prompt: a.prompt, access: a.access, label: a.label })),
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
  args: { plan?: unknown; slug?: unknown },
  ctx: OrchestrationContext,
  deps: RunWorkflowDeps,
): Promise<string> {
  const { plan, errors } = normalizePhasePlan(args?.plan);
  if (!plan) {
    return JSON.stringify({ ok: false, error: 'invalid workflow plan', details: errors }, null, 2);
  }

  const slug = workflowSlug(args, plan);
  const ws = ctx.workspaceRoot;
  ensurePhaseRun(
    ws,
    slug,
    plan.phases.map((p) => ({ id: p.id, title: p.title })),
    { sessionKey: ctx.parentSessionKey ?? null, pid: process.pid, kind: 'workflow' },
  );

  const runner =
    deps.runner ?? defaultPhaseRunner(ctx, deps.dispatch, getCliKnobs().maxConcurrentChildren ?? 8);

  const execution = await executePhasePlan(plan, runner, {
    onPhaseStart: (phase) => {
      advanceRunPhase(ws, slug, phase.id, 'running');
    },
    onPhaseComplete: (exec) => {
      advanceRunPhase(ws, slug, exec.id, PHASE_TO_RUN_STATUS[exec.status], {
        childIds: exec.children.map((c) => c.id),
      });
    },
  });

  return JSON.stringify(
    {
      ok: true,
      slug,
      status: execution.status,
      phases: execution.phases.map((p) => ({ id: p.id, status: p.status, children: p.children.length })),
      output: execution.phases[execution.phases.length - 1]?.output ?? '',
    },
    null,
    2,
  );
}

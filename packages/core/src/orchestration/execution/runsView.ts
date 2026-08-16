/**
 * ADR-040 A40-9/A40-10 — the shared projection both hosts render.
 *
 * CLI `/runs` and Desktop Runs must not each decide what a run "looks like".
 * Two hosts formatting the same events independently is how they end up
 * disagreeing about whether something failed, and the person then has to work
 * out which one to believe.
 *
 * So this module owns the answer and the hosts own only the pixels. It is pure:
 * records in, view model out, no I/O.
 */
import type { ExecutionSnapshot } from './reducer.js';
import type { DurableRunSafeRecord } from './runStore.js';
import type { ResolvedWorkspaceOrchestrationPlan } from '../profiles/orchestrationProfileResolver.js';

export interface RunsListRow {
  runId: string;
  executionId: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  definitionId: string | null;
  /** A40-5 — the goal this run belongs to, so a listing can be grouped by goal. */
  goalId?: string | null;
  /**
   * What the row is allowed to claim. A listing built only from the durable
   * record has no event stream behind it, so it must not imply one.
   */
  detail: 'summary-only' | 'projected';
}

export interface RunDetailView {
  runId: string;
  executionId: string;
  status: string;
  /** A40-9 — the goal this run was launched under, from the durable record. */
  goalId?: string | null;
  /** Carried from the snapshot, never inferred from status. */
  completeness: 'complete' | 'gapped' | 'unavailable';
  /** Present only when completeness is not `complete`. */
  caveat?: string;
  nodes: readonly {
    nodeId: string;
    attempt: number;
    iterationPath: readonly number[];
    status: string;
    /**
     * A40-9 — the child sessions this stage spawned, so a run detail can be
     * DRILLED INTO the transcripts it produced. These are session references, not
     * resume material, so they belong on the rendering surface. Empty for a stage
     * that spawned nothing.
     */
    childSessionIds: readonly string[];
  }[];
  usage: { promptTokens: number; completionTokens: number; toolCalls: number; wallClockMs: number };
}

export function toRunsListRows(records: readonly DurableRunSafeRecord[]): readonly RunsListRow[] {
  return Object.freeze(records.map((record) => ({
    runId: record.runId,
    executionId: record.executionId,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    definitionId: record.definitionId,
    goalId: record.goalId,
    detail: 'summary-only' as const,
  })));
}

/**
 * Build the detail view. When the snapshot is missing or incomplete the view
 * SAYS SO rather than rendering what it has as though it were everything —
 * a partial run drawn as a whole one is a view that lies.
 */
export function toRunDetailView(
  record: DurableRunSafeRecord,
  snapshot: ExecutionSnapshot | undefined,
): RunDetailView {
  if (!snapshot) {
    return {
      runId: record.runId,
      executionId: record.executionId,
      status: record.status,
      goalId: record.goalId,
      completeness: 'unavailable',
      caveat: 'No execution events are retained for this run — only its summary is known.',
      nodes: Object.freeze([]),
      usage: { promptTokens: 0, completionTokens: 0, toolCalls: 0, wallClockMs: 0 },
    };
  }
  return {
    runId: record.runId,
    executionId: record.executionId,
    status: record.status,
    goalId: record.goalId,
    completeness: snapshot.completeness,
    caveat: snapshot.completeness === 'gapped'
      ? 'Some events are missing, so this map is incomplete. What is shown is accurate; what is absent is unknown.'
      : undefined,
    nodes: Object.freeze(snapshot.occurrences.map((o) => ({
      nodeId: o.nodeId,
      attempt: o.attempt,
      iterationPath: o.iterationPath,
      status: o.status,
      childSessionIds: o.childSessionIds,
    }))),
    usage: snapshot.usage,
  };
}

/** Stable machine output for `--json`. Shape is the contract; do not reorder casually. */
export function runsJson(rows: readonly RunsListRow[]): string {
  return JSON.stringify({ schemaVersion: 1, runs: rows }, null, 2);
}

export function runDetailJson(view: RunDetailView): string {
  return JSON.stringify({ schemaVersion: 1, run: view }, null, 2);
}

// ── A40-9 live updates — the terminal-status predicate both hosts poll on ─────

/**
 * The run statuses that mean "done, stop watching". A live `/runs --watch` (or a
 * Desktop live view) stops polling once a run reaches one of these; anything else
 * is still in flight. Kept here so the two hosts cannot disagree about when a run
 * has finished — the same reason the rest of the projection lives in Core.
 */
export const RUN_TERMINAL_STATUSES: readonly string[] = Object.freeze([
  'succeeded', 'failed', 'blocked', 'interrupted', 'cancelled', 'degraded',
]);

export function isTerminalRunStatus(status: string): boolean {
  return RUN_TERMINAL_STATUSES.includes(status);
}

// ── A40-9 preview/confirm start — the shared preview of a strategy before it runs ─

/**
 * A40-9/A40-10 — what an explicit-strategy launch WOULD do, rendered before the
 * user confirms it. Built from the resolved plan so the CLI preview and the
 * Desktop "Run with strategy" dialog show the SAME validated strategy, effective
 * stages, and — crucially — whether it will spawn children. A person confirming a
 * launch is entitled to see one honest answer, not two host-specific ones.
 */
export interface PlanPreview {
  strategyId: string | null;
  selectionSource: string;
  workspaceProfileId: string | null;
  planProfileId: string | null;
  effectiveParallel: number;
  /** True if any stage fans out or the plan runs stages in parallel — i.e. it creates children. */
  createsChildren: boolean;
  stages: readonly {
    id: string;
    objective: string;
    executor: string;
    optional: boolean;
    requiresApproval: boolean;
    skillIds: readonly string[];
    fanOut?: { min: number; max: number };
  }[];
}

export function toPlanPreview(plan: ResolvedWorkspaceOrchestrationPlan): PlanPreview {
  return {
    strategyId: plan.strategyId,
    selectionSource: plan.selectionSource,
    workspaceProfileId: plan.workspaceProfileId,
    planProfileId: plan.planProfileId,
    effectiveParallel: plan.effectiveParallel,
    createsChildren: plan.stages.some((stage) => stage.fanOut !== undefined)
      || plan.effectiveParallel > 1,
    stages: Object.freeze(plan.stages.map((stage) => ({
      id: stage.id,
      objective: stage.objective,
      executor: stage.executor.kind,
      optional: stage.optional,
      requiresApproval: stage.requiresApproval,
      skillIds: stage.skillIds,
      ...(stage.fanOut ? { fanOut: stage.fanOut } : {}),
    }))),
  };
}

/** Plain lines for the CLI preview. Desktop renders the same PlanPreview its own way. */
export function planPreviewLines(preview: PlanPreview): string[] {
  const lines: string[] = [
    `strategy: ${preview.strategyId ?? '(direct)'}  [${preview.selectionSource}]`,
    `profile:  ${preview.planProfileId ?? '—'}` + (preview.workspaceProfileId && preview.workspaceProfileId !== preview.planProfileId ? ` (workspace ${preview.workspaceProfileId})` : ''),
    preview.createsChildren
      ? `children: YES — up to ${preview.effectiveParallel} in parallel`
      : 'children: none (runs on the primary agent)',
    `stages (${preview.stages.length}):`,
  ];
  for (const stage of preview.stages) {
    const marks = [
      stage.optional ? 'optional' : null,
      stage.requiresApproval ? 'approval' : null,
      stage.fanOut ? `fan-out ${stage.fanOut.min}-${stage.fanOut.max}` : null,
      stage.skillIds.length ? `skills: ${stage.skillIds.join(',')}` : null,
    ].filter(Boolean).join(', ');
    lines.push(`  - ${stage.id} (${stage.executor})${marks ? ` [${marks}]` : ''}: ${stage.objective}`);
  }
  return lines;
}

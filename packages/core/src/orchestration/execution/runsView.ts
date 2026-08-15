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

export interface RunsListRow {
  runId: string;
  executionId: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  definitionId: string | null;
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
  /** Carried from the snapshot, never inferred from status. */
  completeness: 'complete' | 'gapped' | 'unavailable';
  /** Present only when completeness is not `complete`. */
  caveat?: string;
  nodes: readonly {
    nodeId: string;
    attempt: number;
    iterationPath: readonly number[];
    status: string;
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
    completeness: snapshot.completeness,
    caveat: snapshot.completeness === 'gapped'
      ? 'Some events are missing, so this map is incomplete. What is shown is accurate; what is absent is unknown.'
      : undefined,
    nodes: Object.freeze(snapshot.occurrences.map((o) => ({
      nodeId: o.nodeId,
      attempt: o.attempt,
      iterationPath: o.iterationPath,
      status: o.status,
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

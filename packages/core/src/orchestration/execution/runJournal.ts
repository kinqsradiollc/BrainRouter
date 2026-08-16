/**
 * ADR-040 A40-9 — the retained per-run event journal.
 *
 * A40-6 keeps a run's IDENTITY and resume point durably; this keeps its EVENT
 * STREAM, so `/runs <id>` (and Desktop Runs) can rebuild the actual execution map
 * from disk instead of reporting `unavailable`. It is an append-only JSONL log
 * beside the durable record, written best-effort as events are emitted and read
 * back through the same reducer the live view uses — one projection, whether the
 * run is happening now or is being read back from a retained log.
 *
 * Bounded: the log stops growing once it reaches a byte ceiling. A run that hits
 * the ceiling reduces to a `gapped` snapshot — an honest "there is more I did not
 * keep", never a silent truncation dressed up as the whole story.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionEvent } from '@kinqs/brainrouter-agent-protocol';
import { readDurableRunSafe } from './runStore.js';
import { reduceExecutionEvents } from './reducer.js';
import { toRunDetailView, type RunDetailView } from './runsView.js';

const JOURNAL_FILE = 'events.jsonl';

export const RUN_JOURNAL_BOUNDS = {
  /** Stop appending past this size. Generous for bounded runs; caps a runaway. */
  maxBytes: 4 * 1024 * 1024,
} as const;

/** The same filesystem-safe run-id rule the durable store enforces. */
function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(runId);
}

function journalPath(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'runs', runId, JOURNAL_FILE);
}

/**
 * Append one canonical event to a run's retained journal. Append-only and
 * best-effort: it never throws, so a journal failure cannot break the run it is
 * only recording. Silently stops once the log reaches its byte ceiling.
 */
export function appendRunEvent(workspaceRoot: string, runId: string, event: ExecutionEvent): void {
  if (!isSafeRunId(runId)) return;
  try {
    const dir = path.join(workspaceRoot, '.brainrouter', 'runs', runId);
    const file = path.join(dir, JOURNAL_FILE);
    // Cheap bound: size the existing file rather than counting lines.
    try {
      if (fs.statSync(file).size >= RUN_JOURNAL_BOUNDS.maxBytes) return;
    } catch { /* not created yet — fall through and create it */ }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    /* best-effort: the journal never blocks a run */
  }
}

/**
 * Read a run's retained events, in the order they were written. Malformed lines
 * are skipped rather than aborting the read — a torn last write must not make the
 * whole history unreadable.
 */
export function readRunEvents(workspaceRoot: string, runId: string): readonly ExecutionEvent[] {
  if (!isSafeRunId(runId)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath(workspaceRoot, runId), 'utf8');
  } catch {
    return [];
  }
  const events: ExecutionEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as ExecutionEvent);
    } catch {
      /* skip a torn/partial line */
    }
  }
  return events;
}

/**
 * ADR-040 A40-9 — the retained-replay entry a host renders: read the durable
 * record and its journal, reduce the events through the SAME reducer the live
 * view uses, and project the detail. A run with no retained events reduces to
 * `undefined`, and `toRunDetailView` reports that as `unavailable` rather than
 * drawing an empty map as though it were the whole run.
 */
export function readRunDetail(workspaceRoot: string, runId: string): RunDetailView | undefined {
  const record = readDurableRunSafe(workspaceRoot, runId);
  if (!record) return undefined;
  const events = readRunEvents(workspaceRoot, runId);
  const snapshot = events.length
    ? reduceExecutionEvents(events).snapshot(record.executionId)
    : undefined;
  return toRunDetailView(record, snapshot);
}

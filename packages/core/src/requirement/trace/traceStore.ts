/**
 * REQUIREMENT TRACE SNAPSHOT STORE (0.4.16) — durable side of the SDD trace.
 *
 * At plan-generation time we snapshot the content hash of every requirement
 * into a session-scoped `trace.json`; on later requirement edits we diff the
 * live requirements against that snapshot to detect DRIFT ("requirements
 * changed after planning — the plan may be stale"). Persistence mirrors
 * `task/planHistoryStore.ts` (session-scoped JSON via the storage helpers); all
 * the actual logic lives in the pure `trace.ts` functions this wraps.
 */

import { getSessionStateFile, readJsonFile, writeJsonFile } from '../../storage/store.js';
import {
  snapshotTrace,
  diffTrace,
  type TraceRequirement,
  type TraceSnapshot,
  type TraceDrift,
} from './trace.js';

function traceFile(workspaceRoot: string, sessionKey: string): string {
  return getSessionStateFile(workspaceRoot, sessionKey, 'trace.json');
}

/**
 * The stored snapshot, or a FRESH empty one when none exists yet. A fresh
 * literal per call (never a shared constant) because `readJsonFile` returns the
 * default by reference when the file is missing — see the same note in
 * planHistoryStore — and callers diff against it.
 */
export function readTraceSnapshot(workspaceRoot: string, sessionKey: string): TraceSnapshot {
  return readJsonFile<TraceSnapshot>(traceFile(workspaceRoot, sessionKey), { version: 1, blocks: {} });
}

/** Snapshot the current requirements' content hashes and persist them. */
export function recordTraceSnapshot(
  workspaceRoot: string,
  sessionKey: string,
  requirements: TraceRequirement[],
): TraceSnapshot {
  const snapshot = snapshotTrace(requirements);
  writeJsonFile(traceFile(workspaceRoot, sessionKey), snapshot);
  return snapshot;
}

/**
 * Diff the live requirements against the stored snapshot. `stale` is true when
 * any requirement was edited / added / removed since the plan was generated —
 * the cue for the desktop "Replan affected steps" banner. With no prior
 * snapshot every current requirement reads as `added` (stale), which is the
 * right default: a plan generated before the trace existed can't be trusted.
 */
export function detectDrift(
  workspaceRoot: string,
  sessionKey: string,
  currentRequirements: TraceRequirement[],
): TraceDrift {
  const before = readTraceSnapshot(workspaceRoot, sessionKey);
  return diffTrace(before, snapshotTrace(currentRequirements));
}

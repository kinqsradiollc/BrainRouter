/**
 * ADR-040 A40-6 — durable execution identity and protected resume storage.
 *
 * One directory per LAUNCH, not per definition. Two saved runs of the same
 * workflow are two runs; sharing a path by definition id means the second
 * silently overwrites the first, and the evidence of the first is simply gone.
 *
 * The payload is split in two, and the split is the point:
 *
 *   `safe.json`      — identity, status, counts. Readable by any surface that
 *                      lists runs, and safe to show.
 *   `protected.json` — resume state: the material needed to CONTINUE a run.
 *                      Written 0600, never returned by list operations, and
 *                      fetched only by an explicit resume call.
 *
 * Listing a run and resuming it are different authorities. Keeping them in one
 * document means every list view carries resume material it has no use for, and
 * the first surface that logs its own response leaks it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../../util/fs/atomicFile.js';

export const RUN_STORE_BOUNDS = {
  /** Runs retained per workspace before the oldest are pruned. */
  maxRetainedRuns: 100,
  maxPageSize: 50,
} as const;

export interface DurableRunSafeRecord {
  schemaVersion: number;
  runId: string;
  executionId: string;
  /** Immutable: what was launched, fixed at launch time. */
  definitionId: string | null;
  definitionHash: string | null;
  /** A40-9 — the goal this run was launched under, fixed at launch; null for a normal turn. */
  goalId?: string | null;
  subworkflowHashes: readonly string[];
  status: string;
  startedAt: string;
  endedAt?: string;
  /** Monotonic; every write increments it so a stale writer can be detected. */
  revision: number;
}

export interface DurableRunProtectedRecord {
  schemaVersion: number;
  runId: string;
  revision: number;
  resumeState: unknown;
}

export interface DurableRunListing {
  runs: readonly DurableRunSafeRecord[];
  nextCursor: string | null;
}

const SCHEMA_VERSION = 1;
const SAFE_FILE = 'safe.json';
const PROTECTED_FILE = 'protected.json';

function runsRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'runs');
}

/** One directory per launch. The id is the identity; nothing is derived from it. */
function runDir(workspaceRoot: string, runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`unsafe run id: ${runId}`);
  return path.join(runsRoot(workspaceRoot), runId);
}

function readJsonIfPresent(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function hashDefinition(definition: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(definition ?? null)).digest('hex');
}

export interface StartRunInput {
  workspaceRoot: string;
  runId: string;
  executionId: string;
  definitionId?: string | null;
  definitionHash?: string | null;
  goalId?: string | null;
  subworkflowHashes?: readonly string[];
  startedAt: string;
  resumeState?: unknown;
}

/** Create a run's durable home. Refuses to clobber an existing launch. */
export function startDurableRun(input: StartRunInput): DurableRunSafeRecord {
  const dir = runDir(input.workspaceRoot, input.runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe: DurableRunSafeRecord = {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    executionId: input.executionId,
    definitionId: input.definitionId ?? null,
    definitionHash: input.definitionHash ?? null,
    goalId: input.goalId ?? null,
    subworkflowHashes: Object.freeze([...(input.subworkflowHashes ?? [])]),
    status: 'running',
    startedAt: input.startedAt,
    revision: 1,
  };
  // exclusive: a second launch must not silently take over the first's directory.
  writeFileAtomic(path.join(dir, SAFE_FILE), JSON.stringify(safe, null, 2), { exclusive: true });
  if (input.resumeState !== undefined) {
    writeProtected(input.workspaceRoot, input.runId, 1, input.resumeState);
  }
  pruneOldRuns(input.workspaceRoot);
  return safe;
}

function writeProtected(
  workspaceRoot: string,
  runId: string,
  revision: number,
  resumeState: unknown,
): void {
  const record: DurableRunProtectedRecord = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    revision,
    resumeState,
  };
  // 0600: resume material is not world-readable, even for a moment.
  writeFileAtomic(
    path.join(runDir(workspaceRoot, runId), PROTECTED_FILE),
    JSON.stringify(record, null, 2),
    { mode: 0o600 },
  );
}

/**
 * Advance a run. `expectedRevision` is a compare-and-set: a writer that read an
 * older revision loses rather than overwriting a newer one, which is what makes
 * two processes touching the same run safe.
 */
export function updateDurableRun(
  workspaceRoot: string,
  runId: string,
  patch: { status?: string; endedAt?: string; resumeState?: unknown },
  expectedRevision?: number,
): DurableRunSafeRecord {
  const current = readDurableRunSafe(workspaceRoot, runId);
  if (!current) throw new Error(`run not found: ${runId}`);
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    throw new Error(
      `run ${runId} moved on: expected revision ${expectedRevision}, found ${current.revision}`,
    );
  }
  const next: DurableRunSafeRecord = {
    ...current,
    status: patch.status ?? current.status,
    endedAt: patch.endedAt ?? current.endedAt,
    revision: current.revision + 1,
  };
  writeFileAtomic(
    path.join(runDir(workspaceRoot, runId), SAFE_FILE),
    JSON.stringify(next, null, 2),
  );
  if (patch.resumeState !== undefined) {
    writeProtected(workspaceRoot, runId, next.revision, patch.resumeState);
  }
  return next;
}

/** The safe half. Never includes resume material. */
export function readDurableRunSafe(
  workspaceRoot: string,
  runId: string,
): DurableRunSafeRecord | undefined {
  const raw = readJsonIfPresent(path.join(runDir(workspaceRoot, runId), SAFE_FILE));
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as DurableRunSafeRecord;
  if (record.schemaVersion !== SCHEMA_VERSION || typeof record.runId !== 'string') return undefined;
  return record;
}

/**
 * The protected half, fetched explicitly. Returns undefined when the protected
 * record is behind the safe one — a torn pair is not a resume point, and
 * resuming from stale state is worse than refusing to resume.
 */
export function readDurableRunResumeState(
  workspaceRoot: string,
  runId: string,
): { resumeState: unknown; revision: number } | undefined {
  const safe = readDurableRunSafe(workspaceRoot, runId);
  if (!safe) return undefined;
  const raw = readJsonIfPresent(path.join(runDir(workspaceRoot, runId), PROTECTED_FILE));
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as DurableRunProtectedRecord;
  if (record.schemaVersion !== SCHEMA_VERSION || record.runId !== runId) return undefined;
  if (record.revision !== safe.revision) return undefined;
  return { resumeState: record.resumeState, revision: record.revision };
}

/**
 * EVERY run, newest first. Internal: retention and crash reconciliation must see
 * the whole directory. Reading them through the PAGED listing was a real bug —
 * the page cap (50) is smaller than the retention bound (100), so pruning could
 * never fire and a crash would only ever reconcile the newest page, leaving
 * older dead runs reporting themselves as still running.
 */
function allRunRecords(workspaceRoot: string): DurableRunSafeRecord[] {
  const root = runsRoot(workspaceRoot);
  let ids: string[];
  try {
    ids = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return ids
    .map((id) => readDurableRunSafe(workspaceRoot, id))
    .filter((r): r is DurableRunSafeRecord => Boolean(r))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

/** Paged listing, newest first. Corrupt entries are skipped, never thrown on. */
export function listDurableRuns(
  workspaceRoot: string,
  options: { limit?: number; cursor?: string | null; goalId?: string | null } = {},
): DurableRunListing {
  const all = allRunRecords(workspaceRoot);
  // A40-5 goal grouping — restrict to one goal's runs when asked, before paging,
  // so the cursor walks the filtered set rather than skipping across goals.
  const records = options.goalId ? all.filter((r) => r.goalId === options.goalId) : all;
  const start = options.cursor ? records.findIndex((r) => r.runId === options.cursor) + 1 : 0;
  const limit = Math.min(options.limit ?? RUN_STORE_BOUNDS.maxPageSize, RUN_STORE_BOUNDS.maxPageSize);
  const page = records.slice(start, start + limit);
  const nextIndex = start + limit;
  return {
    runs: Object.freeze(page),
    nextCursor: nextIndex < records.length ? (page[page.length - 1]?.runId ?? null) : null,
  };
}

/**
 * A run left `running` by a crash is INTERRUPTED, not still going. Reporting it
 * as running forever is how a dead run keeps a queue slot and a person keeps
 * waiting for it.
 */
export function reconcileInterruptedRuns(workspaceRoot: string): readonly string[] {
  const reconciled: string[] = [];
  for (const record of allRunRecords(workspaceRoot)) {
    if (record.status !== 'running') continue;
    updateDurableRun(workspaceRoot, record.runId, { status: 'interrupted' }, record.revision);
    reconciled.push(record.runId);
  }
  return Object.freeze(reconciled);
}

/** Retention: oldest launches are pruned so the directory cannot grow forever. */
export function pruneOldRuns(workspaceRoot: string): readonly string[] {
  const all = allRunRecords(workspaceRoot);
  if (all.length <= RUN_STORE_BOUNDS.maxRetainedRuns) return Object.freeze([]);
  const doomed = all.slice(RUN_STORE_BOUNDS.maxRetainedRuns);
  for (const record of doomed) {
    fs.rmSync(runDir(workspaceRoot, record.runId), { recursive: true, force: true });
  }
  return Object.freeze(doomed.map((r) => r.runId));
}

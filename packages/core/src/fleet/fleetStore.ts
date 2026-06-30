/**
 * HONK-H3 — durable, GLOBAL fleet job queue.
 *
 * Generalizes the brain's memory-job scheduler + the per-workspace durable-task
 * stores into ONE cross-workspace queue at `~/.brainrouter/fleet/jobs.json`, so a
 * fleet runner can drain work across many repos under a single shared concurrency
 * cap and survive a host restart. The cap is enforced at CLAIM time
 * (`claimNextFleetJob`): the runner can never start more than `capacity` jobs at
 * once. Retries use exponential backoff — on BOTH the executor-failure path
 * (`failFleetJob`) and the host-restart path (`reconcileStaleFleetJobs`), so a job
 * that crashes its host can't burn every attempt across instant reboots.
 *
 * Attempt accounting: `attempts` counts CLAIMS (incremented when claimed), and a
 * host interruption consumes a claim just like a real failure — that bound is what
 * stops a poison job from looping a crashing host forever. So `maxAttempts` is
 * "max claims": set it ≥ 2 for a job to tolerate one mid-run host restart
 * (the default of 3 tolerates two).
 *
 * Concurrency: all reads/writes are SYNCHRONOUS read-modify-write over an
 * atomically-renamed JSON file, so within one host process (the runner's
 * reentrancy-guarded tick) claims are race-free — two store calls can never
 * interleave their read and write (JS is single-threaded; no `await` sits inside a
 * store function). Cross-process draining of the SAME home by two hosts is not yet
 * locked — a single fleet runner per host is the supported model (a lockfile is a
 * follow-up).
 *
 * Durability caveats: (1) terminal (done/failed/cancelled) records are pruned to
 * the most-recent `MAX_TERMINAL_RETAINED` so the file — which is fully parsed and
 * re-serialized on every operation — stays bounded; active jobs are never pruned.
 * (2) `readJsonFile` quarantines an unparseable file and falls back to empty, so a
 * corrupt `jobs.json` reads as an empty queue (the atomic tmp+rename write path
 * makes that unlikely, but it is a loud-failure gap shared by every brainrouter
 * store, not a fleet-specific one).
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getBrainrouterHome, readJsonFile, writeJsonFile } from '../storage/store.js';

export type FleetJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface FleetJobRecord {
  id: string;
  /** Executor selector (e.g. 'build', 'delegate') — the runner routes on this. */
  kind: string;
  status: FleetJobStatus;
  /** Absolute repo/workspace root this job targets. */
  workspaceRoot: string;
  /** Free-form executor input (e.g. a delegation packet, a recipe). */
  input: Record<string, unknown>;
  priority: number;
  attempts: number;
  maxAttempts: number;
  /** ISO time before which the job must not be claimed (backoff gate). */
  runAfter?: string;
  /** Caller-supplied dedup key — an in-flight job with the same key is reused. */
  idempotencyKey?: string;
  /** PID of the process that claimed it (for boot reconciliation). */
  pid?: number;
  output?: unknown;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface CreateFleetJobInput {
  kind: string;
  workspaceRoot: string;
  input?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  idempotencyKey?: string;
}

interface FleetJobFile {
  version: 1;
  jobs: FleetJobRecord[];
}
/**
 * A FRESH empty file every call. `readJsonFile` returns its fallback BY REFERENCE
 * when the file is absent, so handing it a shared constant would let the first
 * mutating writer (`enqueueFleetJob` → `data.jobs.push`) poison the constant —
 * and thus every other not-yet-created home reading the same fallback.
 */
function emptyFile(): FleetJobFile {
  return { version: 1, jobs: [] };
}

// --- retry backoff (mirrors the brain scheduler: 30s·2^(n-1), cap 5m, ±20%) ----
export const FLEET_BASE_DELAY_MS = 30_000;
export const FLEET_MAX_DELAY_MS = 5 * 60_000;
const JITTER = 0.2;
export function fleetBackoffMs(attempts: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempts));
  const capped = Math.min(FLEET_BASE_DELAY_MS * 2 ** (n - 1), FLEET_MAX_DELAY_MS);
  const jitter = capped * JITTER * (random() * 2 - 1);
  return Math.max(0, Math.min(FLEET_MAX_DELAY_MS, Math.round(capped + jitter)));
}

/** Most-recent terminal records kept on disk; older ones are pruned on write so
 *  the whole-file parse/serialize cost stays bounded on a busy host. */
export const MAX_TERMINAL_RETAINED = 500;
const TERMINAL: ReadonlySet<FleetJobStatus> = new Set<FleetJobStatus>(['done', 'failed', 'cancelled']);

/** Drop the oldest terminal jobs beyond the cap; never touch pending/running. */
function compactJobs(jobs: FleetJobRecord[], keep: number = MAX_TERMINAL_RETAINED): FleetJobRecord[] {
  const terminalCount = jobs.reduce((n, j) => (TERMINAL.has(j.status) ? n + 1 : n), 0);
  if (terminalCount <= keep) return jobs;
  // Rank terminal jobs by completion time (oldest first) and mark the overflow
  // for removal. Active jobs are kept regardless of where they sort.
  const overflow = jobs
    .filter((j) => TERMINAL.has(j.status))
    .sort((a, b) => (a.completedAt ?? a.updatedAt).localeCompare(b.completedAt ?? b.updatedAt))
    .slice(0, terminalCount - keep);
  const drop = new Set(overflow.map((j) => j.id));
  return jobs.filter((j) => !drop.has(j.id));
}

function fleetFile(home?: string): string {
  return path.join(home ?? getBrainrouterHome(), 'fleet', 'jobs.json');
}
function read(home?: string): FleetJobFile {
  return readJsonFile<FleetJobFile>(fleetFile(home), emptyFile());
}
function write(data: FleetJobFile, home?: string): void {
  writeJsonFile(fleetFile(home), { ...data, jobs: compactJobs(data.jobs) });
}
/** Hand callers a defensive deep copy so mutating a returned record (notably the
 *  job an executor receives) can never corrupt the in-memory store snapshot. */
function clone<T>(value: T): T {
  return structuredClone(value);
}
const ACTIVE: FleetJobStatus[] = ['pending', 'running'];

/** Enqueue a job. If an in-flight (pending/running) job shares its idempotencyKey,
 *  that existing job is returned instead (deduped) — safe to call repeatedly. */
export function enqueueFleetJob(
  input: CreateFleetJobInput,
  opts?: { home?: string; now?: Date },
): { job: FleetJobRecord; deduped: boolean } {
  const data = read(opts?.home);
  if (input.idempotencyKey) {
    const existing = data.jobs.find((j) => j.idempotencyKey === input.idempotencyKey && ACTIVE.includes(j.status));
    if (existing) return { job: clone(existing), deduped: true };
  }
  const at = (opts?.now ?? new Date()).toISOString();
  const job: FleetJobRecord = {
    id: `fleet_${randomUUID().slice(0, 8)}`,
    kind: input.kind,
    status: 'pending',
    workspaceRoot: input.workspaceRoot,
    input: input.input ?? {},
    priority: input.priority ?? 0,
    attempts: 0,
    maxAttempts: Math.max(1, input.maxAttempts ?? 3),
    idempotencyKey: input.idempotencyKey,
    createdAt: at,
    updatedAt: at,
  };
  data.jobs.push(job);
  write(data, opts?.home);
  return { job: clone(job), deduped: false };
}

export function getFleetJob(id: string, home?: string): FleetJobRecord | undefined {
  const job = read(home).jobs.find((j) => j.id === id);
  return job ? clone(job) : undefined;
}

export function listFleetJobs(filter?: { status?: FleetJobStatus[]; workspaceRoot?: string }, home?: string): FleetJobRecord[] {
  return read(home)
    .jobs.filter(
      (j) => (!filter?.status || filter.status.includes(j.status)) && (!filter?.workspaceRoot || j.workspaceRoot === filter.workspaceRoot),
    )
    .map(clone);
}

export function countRunningFleetJobs(home?: string): number {
  return read(home).jobs.reduce((n, j) => (j.status === 'running' ? n + 1 : n), 0);
}

/**
 * Atomically claim the next runnable job IF the global cap allows. Returns null
 * when at capacity or nothing is runnable. Picks the highest-priority job whose
 * `runAfter` has passed (oldest first on a tie). Marks it running + stamps pid.
 */
export function claimNextFleetJob(
  capacity: number,
  opts?: { home?: string; pid?: number; now?: Date },
): FleetJobRecord | null {
  const data = read(opts?.home);
  const running = data.jobs.reduce((n, j) => (j.status === 'running' ? n + 1 : n), 0);
  if (capacity > 0 && running >= capacity) return null;
  const now = opts?.now ?? new Date();
  const runnable = data.jobs
    .filter((j) => j.status === 'pending' && (!j.runAfter || new Date(j.runAfter) <= now))
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  const job = runnable[0];
  if (!job) return null;
  job.status = 'running';
  job.attempts += 1;
  job.pid = opts?.pid ?? process.pid;
  job.startedAt = now.toISOString();
  job.updatedAt = job.startedAt;
  delete job.runAfter;
  write(data, opts?.home);
  return clone(job);
}

export function completeFleetJob(id: string, output?: unknown, opts?: { home?: string; now?: Date }): void {
  const data = read(opts?.home);
  const job = data.jobs.find((j) => j.id === id);
  if (!job) return;
  const at = (opts?.now ?? new Date()).toISOString();
  job.status = 'done';
  job.output = output;
  job.completedAt = at;
  job.updatedAt = at;
  delete job.pid;
  write(data, opts?.home);
}

/** Fail a job: re-arm it as `pending` with a backoff `runAfter` while attempts
 *  remain, else mark it terminally `failed`. */
export function failFleetJob(
  id: string,
  error: string,
  opts?: { home?: string; now?: Date; random?: () => number },
): FleetJobRecord | undefined {
  const data = read(opts?.home);
  const job = data.jobs.find((j) => j.id === id);
  if (!job) return undefined;
  const now = opts?.now ?? new Date();
  job.error = error;
  job.updatedAt = now.toISOString();
  delete job.pid;
  if (job.attempts < job.maxAttempts) {
    job.status = 'pending';
    job.runAfter = new Date(now.getTime() + fleetBackoffMs(job.attempts, opts?.random)).toISOString();
  } else {
    job.status = 'failed';
    job.completedAt = job.updatedAt;
  }
  write(data, opts?.home);
  return clone(job);
}

export function cancelFleetJob(id: string, opts?: { home?: string; now?: Date }): void {
  const data = read(opts?.home);
  const job = data.jobs.find((j) => j.id === id);
  if (!job || job.status === 'done' || job.status === 'failed') return;
  job.status = 'cancelled';
  job.completedAt = (opts?.now ?? new Date()).toISOString();
  job.updatedAt = job.completedAt;
  delete job.pid;
  write(data, opts?.home);
}

/**
 * Boot reconciliation: any `running` job whose owning process is gone is re-armed
 * for retry (while attempts remain) or terminally failed. This is the "survives a
 * host restart" property — work isn't silently lost when a host dies mid-job, up to
 * `maxAttempts` claims (a mid-run interruption already consumed one at claim time).
 *
 * The re-arm uses the SAME exponential backoff as `failFleetJob`, NOT immediate
 * re-claim: a job whose executor crashes the host would otherwise loop instantly on
 * every reboot, burning all attempts with zero spacing. Backoff gives a crash-loop
 * room to breathe (and a transient outage time to clear).
 *
 * `isAlive` decides liveness. The runner's default is `pid === process.pid`, which
 * at boot re-arms EVERY running job (the fresh process owns none), so it reclaims
 * all orphans regardless of whether some unrelated process reused an old pid. The
 * only gap is the new host being assigned the EXACT pid the dead host had — then
 * that job reads as "alive" and stays `running`; a process-identity (start-time)
 * check is the eventual fix.
 */
export function reconcileStaleFleetJobs(
  isAlive: (pid: number | undefined) => boolean,
  opts?: { home?: string; now?: Date; random?: () => number },
): number {
  const data = read(opts?.home);
  const now = opts?.now ?? new Date();
  let n = 0;
  for (const job of data.jobs) {
    if (job.status !== 'running' || isAlive(job.pid)) continue;
    job.error = 'Interrupted — the host process exited before the job finished.';
    job.updatedAt = now.toISOString();
    delete job.pid;
    if (job.attempts < job.maxAttempts) {
      job.status = 'pending';
      job.runAfter = new Date(now.getTime() + fleetBackoffMs(job.attempts, opts?.random)).toISOString();
    } else {
      job.status = 'failed';
      job.completedAt = job.updatedAt;
    }
    n += 1;
  }
  if (n > 0) write(data, opts?.home);
  return n;
}

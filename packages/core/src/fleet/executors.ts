/**
 * HONK-H3.2 / H4 — fleet executor composition + fan-out.
 *
 * The durable queue (`fleetStore`) and drain loop (`fleetRunner`) are generic; this
 * module is the glue that gives jobs MEANING:
 *
 *  - `enqueueFleetMigration` fans ONE spec across N repo roots into N jobs (the
 *    "migration = N parallel builds" shape) with a per-repo idempotency key so a
 *    re-run is a no-op per repo.
 *  - `makeFleetBuildExecutor` turns a runtime-injected `runBuild` (which actually
 *    runs the agent build in a repo and yields a patch) into a `FleetExecutor` that
 *    delivers the result as a reviewable PR via `emitPrFromPatch`. The heavy build
 *    itself is injected because it needs the full CLI agent runtime (LLM client,
 *    orchestration context) that core deliberately does not depend on.
 *  - `summarizeFleet` is the pure read-model behind a `fleet_status` surface.
 *
 * Everything here is dependency-injected and synchronous-friendly so it unit-tests
 * without a real agent, git remote, or GitHub.
 */
import { emitPrFromPatch, type EmitPrInput, type EmitPrResult, type CmdRunner } from '../git/prEmit.js';
import type { FleetExecutor } from './fleetRunner.js';
import {
  enqueueFleetJob,
  listFleetJobs,
  type FleetJobRecord,
  type FleetJobStatus,
} from './fleetStore.js';

// ----------------------------------------------------------------------------
// Fan-out: one migration spec → N repos → N jobs
// ----------------------------------------------------------------------------

export interface FleetMigrationSpec {
  /** Executor selector the runner routes on. Default `'build'`. */
  kind?: string;
  /** Absolute repo/workspace roots to apply the migration across. */
  repos: string[];
  /** Self-contained executor input shared by every repo (e.g. a delegation packet,
   *  a prompt, a recipe). `workspaceRoot` is injected per repo on top of this. */
  input: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  /** Stable key so re-running the SAME migration dedups per repo (the per-repo key
   *  is `${idempotencyKey}:${repo}`). Omit for always-fresh jobs. */
  idempotencyKey?: string;
}

export interface FleetMigrationResult {
  jobs: FleetJobRecord[];
  /** How many of the N were deduped against an already in-flight job. */
  deduped: number;
}

/** Enqueue one job per (de-duplicated) repo in the spec. Throws on an empty repo
 *  list — a migration targeting nothing is a caller mistake, not a silent no-op. */
export function enqueueFleetMigration(
  spec: FleetMigrationSpec,
  opts?: { home?: string; now?: Date },
): FleetMigrationResult {
  const repos = [...new Set(spec.repos.filter((r) => typeof r === 'string' && r.trim().length > 0))];
  if (repos.length === 0) throw new Error('enqueueFleetMigration: spec.repos is empty.');
  const kind = spec.kind ?? 'build';
  const jobs: FleetJobRecord[] = [];
  let deduped = 0;
  for (const repo of repos) {
    const res = enqueueFleetJob(
      {
        kind,
        workspaceRoot: repo,
        // Carry the shared input plus the repo this job targets, so an executor
        // never has to reach outside the job record for its workspace.
        input: { ...spec.input, workspaceRoot: repo },
        priority: spec.priority,
        maxAttempts: spec.maxAttempts,
        idempotencyKey: spec.idempotencyKey ? `${spec.idempotencyKey}:${repo}` : undefined,
      },
      opts,
    );
    jobs.push(res.job);
    if (res.deduped) deduped += 1;
  }
  return { jobs, deduped };
}

// ----------------------------------------------------------------------------
// Build executor: run a build for the job's repo, deliver it as a PR
// ----------------------------------------------------------------------------

/** What a successful `runBuild` yields: enough to open a reviewable PR. */
export interface FleetBuildResult {
  /** Repo root the patch applies to (the worktree's source root). */
  sourceRoot: string;
  /** Path to the binary patch the build produced. */
  patchPath: string;
  /** Slug seeding the branch name + default PR title. */
  slug: string;
  title: string;
  body: string;
  baseBranch?: string;
  draft?: boolean;
}

/** A build that produced no deliverable (no changes, verify never went green, …). */
export interface FleetBuildSkip {
  skipped: string;
}

function isSkip(v: FleetBuildResult | FleetBuildSkip | null | undefined): v is FleetBuildSkip {
  return !!v && typeof v === 'object' && 'skipped' in v;
}

export interface FleetBuildExecutorDeps {
  /**
   * Runtime-injected: actually run the agent build in `job.workspaceRoot` and
   * return a patch to deliver, or a skip when there's nothing to ship. Throwing
   * fails the job (→ the queue's backoff/retry). Injected because the real build
   * needs the CLI agent runtime that core does not import.
   */
  runBuild: (job: FleetJobRecord) => Promise<FleetBuildResult | FleetBuildSkip | null>;
  /** PR emitter (default `emitPrFromPatch`); overridable for tests. */
  emitPr?: (input: EmitPrInput, run?: CmdRunner) => EmitPrResult;
  /** Command runner threaded into the PR emitter (tests inject a fake git/gh). */
  cmd?: CmdRunner;
}

export interface FleetBuildOutput {
  delivered: boolean;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  /** Set when the build or the emit declined without erroring (no changes, no gh…). */
  skipped?: string;
}

/** Build a `FleetExecutor` for `kind:'build'` jobs: run the build, then open a PR. */
export function makeFleetBuildExecutor(deps: FleetBuildExecutorDeps): FleetExecutor {
  const emit = deps.emitPr ?? emitPrFromPatch;
  return async (job: FleetJobRecord): Promise<FleetBuildOutput> => {
    const built = await deps.runBuild(job);
    if (isSkip(built) || !built) {
      return { delivered: false, skipped: isSkip(built) ? built.skipped : 'no-build-output' };
    }
    const res = emit(
      {
        sourceRoot: built.sourceRoot,
        patchPath: built.patchPath,
        slug: built.slug,
        // Per-ATTEMPT token: a retry must not reuse the prior attempt's branch
        // (which would collide on push and silently degrade the apply).
        runToken: `${job.id}-${job.attempts}`,
        title: built.title,
        body: built.body,
        baseBranch: built.baseBranch,
        draft: built.draft ?? true,
      },
      deps.cmd,
    );
    // A declined emit (no gh, no remote, empty patch) is a terminal non-error: the
    // build ran, there's just nowhere to push. A hard error retries.
    if (!res.ok && !res.skipped) throw new Error(res.error ?? 'fleet build: PR emit failed');
    return {
      delivered: res.ok,
      prUrl: res.prUrl,
      prNumber: res.prNumber,
      branch: res.branch,
      skipped: res.skipped,
    };
  };
}

// ----------------------------------------------------------------------------
// Status read-model (behind a `fleet_status` surface)
// ----------------------------------------------------------------------------

const ALL_STATUSES: FleetJobStatus[] = ['pending', 'running', 'done', 'failed', 'cancelled'];

export interface FleetSummary {
  total: number;
  byStatus: Record<FleetJobStatus, number>;
  /** Jobs currently executing. */
  running: FleetJobRecord[];
  /** Most-recently-updated terminal jobs (done/failed/cancelled), newest first. */
  recent: FleetJobRecord[];
}

/** Pure snapshot of the queue for status reporting. `recent` is capped (default 10). */
export function summarizeFleet(opts?: { home?: string; workspaceRoot?: string; recent?: number }): FleetSummary {
  const jobs = listFleetJobs(opts?.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : undefined, opts?.home);
  const byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<FleetJobStatus, number>;
  for (const j of jobs) byStatus[j.status] += 1;
  const running = jobs.filter((j) => j.status === 'running');
  const recent = jobs
    .filter((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
    .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))
    .slice(0, Math.max(0, opts?.recent ?? 10));
  return { total: jobs.length, byStatus, running, recent };
}

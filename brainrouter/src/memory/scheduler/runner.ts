/**
 * BRAIN-P1-T3 (0.4.1) — synchronous job wrapper for the live pipeline.
 *
 * `runAsJob` wraps an existing pipeline-stage call so that every run
 * leaves a durable `memory_jobs` row: it enqueues the job, flips it to
 * `running`, executes the real work, and stamps `done` (with a compact
 * output summary) or `failed` (with the error). This is the
 * "observability-first" wiring the design permits — the proven inline
 * scheduling in `capture.ts` is untouched; we only make each stage
 * observable + auditable.
 *
 * Notes:
 *  - Jobs created here use `maxAttempts: 1`. There is no background
 *    runner loop yet (a later slice), so a failure is terminal `failed`
 *    rather than a misleading re-armed `pending` that nothing will pick
 *    up. When the async runner lands, queue-scheduled jobs will use the
 *    agent's real `maxAttempts`.
 *  - The original error is re-thrown so existing callers' `.catch`
 *    logging continues to behave exactly as before.
 *  - Enqueue + start happen synchronously before the first `await`, so
 *    the row is visible immediately — even for fire-and-forget callers.
 */

import type { IMemoryStore, MemoryJobRecord } from "@kinqs/brainrouter-types";
import { getJobExecutor, type JobExecContext, type JobExecutor } from "./executors.js";
import { failAgentJob } from "./jobs.js";
import { mapWithConcurrency } from "../util/concurrency.js";

/**
 * Global in-flight ceiling per drain tick: how many jobs the runner claims and
 * runs CONCURRENTLY. Env `BRAINROUTER_JOB_CONCURRENCY` (default 8, capped 64).
 */
export function readJobConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const def = 8;
  const raw = env.BRAINROUTER_JOB_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 64) : def;
}

/**
 * Per-tenant concurrency cap: at most this many of one tenant's jobs run at once,
 * so one busy org can't starve the shared queue. Env
 * `BRAINROUTER_JOB_TENANT_CONCURRENCY` (default 4, capped 64).
 */
export function readJobTenantConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const def = 4;
  const raw = env.BRAINROUTER_JOB_TENANT_CONCURRENCY;
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 64) : def;
}

/**
 * The store surface the runner needs beyond `IMemoryStore`. `claimNextMemoryJob`
 * accepts an extra `perTenantLimit` on the concrete Postgres store (a wider,
 * assignable signature); this local type lets the runner pass it without widening
 * the shared `IMemoryStore` contract.
 */
type TenantAwareClaim = {
  claimNextMemoryJob(options?: { now?: string; perTenantLimit?: number }): Promise<MemoryJobRecord | null>;
};

export interface RunAsJobOptions<T> {
  /** Higher runs sooner if ever queued. Defaults to the store default (50). */
  priority?: number;
  /**
   * Maps the stage result to a small JSON summary stored on the job's
   * `output`. Keep it compact (counts, ids) — not the full payload.
   * Defaults to `{ ok: true }`.
   */
  summarize?: (result: T) => unknown;
}

export interface RunAsJobResult<T> {
  result: T;
  job: MemoryJobRecord;
}

/**
 * Run `fn` as an observable brain-agent job. Returns the stage result
 * plus the terminal job row. Re-throws on failure (after recording the
 * job as `failed`).
 */
export async function runAsJob<T>(
  store: IMemoryStore,
  agentId: string,
  input: unknown,
  fn: () => Promise<T>,
  options?: RunAsJobOptions<T>,
): Promise<RunAsJobResult<T>> {
  const job = await store.enqueueMemoryJob({
    kind: agentId,
    input,
    maxAttempts: 1,
    priority: options?.priority,
  });
  await store.startMemoryJob(job.id);
  try {
    const result = await fn();
    const summary = options?.summarize ? options.summarize(result) : { ok: true };
    const done = await store.completeMemoryJob(job.id, summary);
    return { result, job: done ?? job };
  } catch (err: any) {
    await store.failMemoryJob(job.id, err?.message ?? String(err));
    throw err;
  }
}

/**
 * MEM-10b — record an already-completed inline operation as an observable
 * brain-agent job, synchronously (enqueue → start → complete). Unlike
 * `runAsJob`, this does NOT wrap/own the work — the stage already ran inline on
 * the hot path; this only leaves an audit row so the agent shows activity in the
 * status panel instead of "idle · never". Best-effort: any failure is logged and
 * swallowed so observability can never break the path it instruments.
 */
export async function recordInlineJob(
  store: IMemoryStore,
  agentId: string,
  input: unknown,
  summary?: unknown,
): Promise<void> {
  try {
    const job = await store.enqueueMemoryJob({ kind: agentId, input, maxAttempts: 1 });
    await store.startMemoryJob(job.id);
    await store.completeMemoryJob(job.id, summary ?? { ok: true });
  } catch (err: any) {
    console.error(`[BrainRouter] recordInlineJob(${agentId}) failed:`, err?.message ?? err);
  }
}

export interface MemoryJobRunnerOptions {
  /** How often to poll for eligible jobs. Default 3000ms. */
  intervalMs?: number;
  /**
   * Global in-flight ceiling: how many jobs one tick claims and runs
   * CONCURRENTLY. Defaults to `BRAINROUTER_JOB_CONCURRENCY` (8).
   */
  maxPerTick?: number;
  /**
   * Per-tenant concurrency cap enforced at claim time — a tenant with this many
   * `running` jobs is skipped so it can't starve the queue. `0` disables the cap.
   * Defaults to `BRAINROUTER_JOB_TENANT_CONCURRENCY` (4).
   */
  perTenantLimit?: number;
  /** A `running` job whose lock is older than this is swept. Default 5 min. */
  stuckMs?: number;
  /**
   * Resolve a job kind to its executor. Defaults to the built-in
   * registry (`getJobExecutor`); injectable so tests can drive the
   * lifecycle with deterministic stub executors.
   */
  resolveExecutor?: (agentId: string) => JobExecutor | undefined;
  /**
   * 0.4.3 — best-effort hook run at the START of every drain tick, before jobs
   * are claimed, so freshly-enqueued work can be drained the same tick. The
   * engine wires this to its scheduled-maintenance enqueue (vault / blackboard).
   * Never blocks the runner: a throwing/slow onTick is caught and the drain
   * proceeds. The hook owns its own cadence throttle.
   */
  onTick?: () => void | Promise<void>;
}

/**
 * BRAIN-P1 async runner — drains queued `memory_jobs` rows that were
 * enqueued out-of-band (via `memory_agent_run` / `/brain run`). Capture
 * stages run inline via `runAsJob` and are already terminal when
 * written, so the runner only ever sees manual enqueues.
 *
 * Cross-process safe: `claimNextMemoryJob` takes the write lock
 * (BEGIN IMMEDIATE), so when several brain processes share one DB only
 * one runner claims a given job. The timer is `unref`'d so it never
 * keeps a process alive on its own, and a reentrancy guard prevents
 * overlapping ticks (mirrors the engine's sweepers).
 */
export class MemoryJobRunner {
  private timer?: ReturnType<typeof setInterval>;
  private inProgress = false;
  private readonly intervalMs: number;
  private readonly maxPerTick: number;
  private readonly perTenantLimit: number;
  private readonly stuckMs: number;
  private readonly resolveExecutor: (agentId: string) => JobExecutor | undefined;
  private readonly onTick?: () => void | Promise<void>;

  constructor(
    private readonly store: IMemoryStore,
    private readonly ctx: JobExecContext,
    options?: MemoryJobRunnerOptions,
  ) {
    this.intervalMs = options?.intervalMs ?? 3000;
    this.maxPerTick = options?.maxPerTick ?? readJobConcurrency();
    this.perTenantLimit = options?.perTenantLimit ?? readJobTenantConcurrency();
    this.stuckMs = options?.stuckMs ?? 5 * 60_000;
    this.resolveExecutor = options?.resolveExecutor ?? getJobExecutor;
    this.onTick = options?.onTick;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One drain pass: re-arm orphaned locks, then claim up to the global ceiling
   * (`maxPerTick`) of eligible jobs and run them CONCURRENTLY through a bounded
   * pool. Claims are sequential so each claim sees the previous claims' rows as
   * `running` — that's what enforces the per-tenant cap within a single drain.
   * The `inProgress` guard still prevents overlapping drains; parallelism lives
   * WITHIN a drain, not across ticks. Exposed for tests (call directly instead of
   * waiting on the timer). Never throws — a failing job is recorded, not propagated.
   */
  async tick(): Promise<void> {
    if (this.inProgress) return;
    this.inProgress = true;
    try {
      // Best-effort scheduled-maintenance enqueue (own cadence throttle).
      // Isolated so a slow/throwing hook never stalls or breaks the drain.
      if (this.onTick) {
        try {
          await this.onTick();
        } catch (err: any) {
          console.error("[BrainRouter] job runner onTick failed:", err?.message ?? err);
        }
      }
      await this.store.sweepStuckMemoryJobs(this.stuckMs);
      const claim = this.store as unknown as TenantAwareClaim;
      const perTenantLimit = this.perTenantLimit > 0 ? this.perTenantLimit : undefined;
      const claimed: MemoryJobRecord[] = [];
      for (let i = 0; i < this.maxPerTick; i++) {
        const job = await claim.claimNextMemoryJob({ perTenantLimit });
        if (!job) break;
        claimed.push(job);
      }
      if (claimed.length > 0) {
        await mapWithConcurrency(claimed, this.maxPerTick, (job) => this.runOne(job));
      }
    } catch (err: any) {
      console.error("[BrainRouter] memory job runner tick failed:", err?.message ?? err);
    } finally {
      this.inProgress = false;
    }
  }

  private async runOne(job: MemoryJobRecord): Promise<void> {
    const executor = this.resolveExecutor(job.kind);
    if (!executor) {
      // Extraction-family stages run inline during capture; there's no
      // on-demand executor. Cancel with a clear reason rather than loop.
      await this.store.cancelMemoryJob(job.id, {
        reason: `no on-demand executor for '${job.kind}' (runs inline during capture)`,
      });
      return;
    }
    try {
      const output = await executor(job.input, { ...this.ctx, jobId: job.id });
      await this.store.completeMemoryJob(job.id, output ?? { ok: true });
    } catch (err: any) {
      // Keep a terminal timeline event even for executors that throw before they
      // can emit their own progress (best effort; never mask the job failure).
      void this.store.appendJobProgress(job.id, { ts: new Date().toISOString(), kind: "error", msg: err?.message ?? String(err) }).catch(() => {});
      // failAgentJob applies backoff and re-arms while attempts remain,
      // else marks terminal failed.
      await failAgentJob(this.store, job.id, err?.message ?? String(err));
    }
  }
}

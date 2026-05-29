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
  const job = store.enqueueMemoryJob({
    kind: agentId,
    input,
    maxAttempts: 1,
    priority: options?.priority,
  });
  store.startMemoryJob(job.id);
  try {
    const result = await fn();
    const summary = options?.summarize ? options.summarize(result) : { ok: true };
    const done = store.completeMemoryJob(job.id, summary);
    return { result, job: done ?? job };
  } catch (err: any) {
    store.failMemoryJob(job.id, err?.message ?? String(err));
    throw err;
  }
}

export interface MemoryJobRunnerOptions {
  /** How often to poll for eligible jobs. Default 3000ms. */
  intervalMs?: number;
  /** Max jobs to drain per tick (keeps one tick bounded). Default 10. */
  maxPerTick?: number;
  /** A `running` job whose lock is older than this is swept. Default 5 min. */
  stuckMs?: number;
  /**
   * Resolve a job kind to its executor. Defaults to the built-in
   * registry (`getJobExecutor`); injectable so tests can drive the
   * lifecycle with deterministic stub executors.
   */
  resolveExecutor?: (agentId: string) => JobExecutor | undefined;
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
  private readonly stuckMs: number;
  private readonly resolveExecutor: (agentId: string) => JobExecutor | undefined;

  constructor(
    private readonly store: IMemoryStore,
    private readonly ctx: JobExecContext,
    options?: MemoryJobRunnerOptions,
  ) {
    this.intervalMs = options?.intervalMs ?? 3000;
    this.maxPerTick = options?.maxPerTick ?? 10;
    this.stuckMs = options?.stuckMs ?? 5 * 60_000;
    this.resolveExecutor = options?.resolveExecutor ?? getJobExecutor;
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
   * One drain pass: re-arm orphaned locks, then claim + run up to
   * `maxPerTick` eligible jobs. Exposed for tests (call directly instead
   * of waiting on the timer). Never throws — a failing job is recorded,
   * not propagated.
   */
  async tick(): Promise<void> {
    if (this.inProgress) return;
    this.inProgress = true;
    try {
      this.store.sweepStuckMemoryJobs(this.stuckMs);
      for (let i = 0; i < this.maxPerTick; i++) {
        const job = this.store.claimNextMemoryJob();
        if (!job) break;
        await this.runOne(job);
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
      this.store.cancelMemoryJob(job.id, {
        reason: `no on-demand executor for '${job.kind}' (runs inline during capture)`,
      });
      return;
    }
    try {
      const output = await executor(job.input, this.ctx);
      this.store.completeMemoryJob(job.id, output ?? { ok: true });
    } catch (err: any) {
      // failAgentJob applies backoff and re-arms while attempts remain,
      // else marks terminal failed.
      failAgentJob(this.store, job.id, err?.message ?? String(err));
    }
  }
}

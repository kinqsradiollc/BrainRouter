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

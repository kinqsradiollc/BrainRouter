/**
 * HONK-H3 — the fleet drain loop. On an interval it reconciles stale jobs, then
 * CLAIMS runnable jobs up to the shared concurrency cap and runs each one
 * concurrently via an injected executor (keyed by `job.kind`). The cap is enforced
 * by `claimNextFleetJob` (it counts `running` jobs in the durable store), so the
 * runner can never start more than `capacity` at once even across ticks. Executors
 * are injected so the queue mechanics are unit-testable without real agents; the
 * real 'build'/'delegate' executors are wired by later phases (H3.2 / H4).
 */
import {
  claimNextFleetJob,
  completeFleetJob,
  failFleetJob,
  cancelFleetJob,
  reconcileStaleFleetJobs,
  type FleetJobRecord,
} from './fleetStore.js';

/** Runs a claimed job and returns its output; throws to fail (→ backoff/retry). */
export type FleetExecutor = (job: FleetJobRecord) => Promise<unknown>;

export interface FleetRunnerOptions {
  capacity: number;
  executors: Record<string, FleetExecutor>;
  /** Override the home dir (tests). */
  home?: string;
  /** Liveness check for boot reconciliation (default: pid === this process). */
  isAlive?: (pid: number | undefined) => boolean;
  intervalMs?: number;
}

export class FleetJobRunner {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly inFlight = new Set<string>();

  constructor(private readonly opts: FleetRunnerOptions) {}

  /** Re-arm jobs orphaned by a previous host, then begin draining. */
  start(): number {
    const reconciled = reconcileStaleFleetJobs(this.opts.isAlive ?? ((pid) => pid === process.pid), { home: this.opts.home });
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 3000);
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) (this.timer as { unref: () => void }).unref();
    return reconciled;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One drain pass: claim up to the cap and run each claimed job concurrently. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (;;) {
        const job = claimNextFleetJob(this.opts.capacity, { home: this.opts.home });
        if (!job) break; // at capacity, or nothing runnable
        void this.runOne(job);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runOne(job: FleetJobRecord): Promise<void> {
    this.inFlight.add(job.id);
    try {
      const executor = this.opts.executors[job.kind];
      if (!executor) {
        cancelFleetJob(job.id, { home: this.opts.home });
        return;
      }
      try {
        const output = await executor(job);
        completeFleetJob(job.id, output, { home: this.opts.home });
      } catch (err: unknown) {
        failFleetJob(job.id, err instanceof Error ? err.message : String(err), { home: this.opts.home });
      }
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  /** Jobs this runner is currently executing in-process (for observability). */
  get activeCount(): number {
    return this.inFlight.size;
  }
}

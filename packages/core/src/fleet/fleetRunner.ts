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
import { acquireFleetLock, type FleetLockHandle } from './lock.js';

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
  /**
   * Acquire the single-runner host lock before draining (default true). When held
   * elsewhere this runner stands down so two processes never drain one home — the
   * cross-process race the store cannot guard. Disable only in isolated tests that
   * drive `tick()` directly.
   */
  lock?: boolean;
  /** Pid stamped into the lock (default process.pid; tests inject). */
  lockPid?: number;
  /** Liveness predicate for the host lock (default real `process.kill`; tests inject). */
  lockIsAlive?: (pid: number) => boolean;
}

export interface FleetStartResult {
  /** False when another live runner already holds the host lock — we stood down. */
  acquired: boolean;
  /** Jobs re-armed from a dead previous host during boot reconciliation. */
  reconciled: number;
}

export class FleetJobRunner {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private lock?: FleetLockHandle;
  /** Set when start() was refused the host lock: a forced tick() must not drain. */
  private stoodDown = false;
  private readonly inFlight = new Set<string>();

  constructor(private readonly opts: FleetRunnerOptions) {}

  /**
   * Acquire the host lock (unless disabled), re-arm jobs orphaned by a previous
   * host, then begin draining. Returns `{ acquired: false }` without starting a
   * timer when another live runner owns the lock.
   */
  start(): FleetStartResult {
    if (this.opts.lock !== false) {
      this.lock = acquireFleetLock({ home: this.opts.home, pid: this.opts.lockPid, isAlive: this.opts.lockIsAlive }) ?? undefined;
      if (!this.lock) {
        this.stoodDown = true;
        return { acquired: false, reconciled: 0 };
      }
    }
    this.stoodDown = false;
    const reconciled = reconcileStaleFleetJobs(this.opts.isAlive ?? ((pid) => pid === process.pid), { home: this.opts.home });
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 3000);
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) (this.timer as { unref: () => void }).unref();
    return { acquired: true, reconciled };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.lock) {
      this.lock.release();
      this.lock = undefined;
    }
  }

  /** One drain pass: claim up to the cap and run each claimed job concurrently. */
  async tick(): Promise<void> {
    if (this.ticking || this.stoodDown) return;
    // Refresh the lock; if we've lost it (reclaimed after a stall), stand down
    // rather than racing the new owner on jobs.json.
    if (this.lock && !this.lock.heartbeat()) {
      this.stop();
      return;
    }
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

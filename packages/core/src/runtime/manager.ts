/**
 * MC-A4 — the runtime MANAGER: pause/resume + LRU eviction + boot reconcile
 * for the runtime plane.
 *
 * The Phase-1 seam gave every runtime instance a uniform lifecycle
 * (`IAgentRuntime`) and a durable record (`runtimeStateStore`). The manager is
 * the layer ABOVE individual instances: it tracks which instances are LIVE in
 * this process, enforces the `cli.runtime.maxLive` cap by PARKING the
 * least-recently-used live instance instead of failing the next start, and
 * reconciles durable records left behind by a dead process at boot.
 *
 * Semantics:
 *  - `maxLive === 0` → uncapped (the default); nothing is ever auto-parked.
 *  - Starting/resuming instance N+1 over the cap parks the LRU live instance
 *    that is currently `ready` (a mid-turn `running` instance is never yanked).
 *  - `resume(id)` re-attaches parked instances: an in-process handle resumes
 *    directly; a cross-process `worktree` record re-attaches by path via the
 *    Phase-1 `attachWorktreeRuntime` primitive; a cross-process `process`
 *    record is re-hosted as a fresh in-process runtime bound to the same id.
 *  - Boot reconcile (`reconcileRuntimeRecords`, run by `createRuntimeManager`)
 *    flips live-ish records owned by a dead pid to `parked` — except worktree
 *    instances whose tree vanished from disk, which become `error`.
 */

import { getCliKnobs } from '../config/config.js';
import { isSecretShapedEnvVar } from '../exec/runtime/sandbox.js';
import type { IAgentRuntime, RuntimeTurn, RuntimeTurnExecutor, RuntimeTurnResult } from './runtimeTypes.js';
import { attachContainerRuntime } from './backends/container.js';
import { createProcessRuntime } from './backends/process.js';
import { attachWorktreeRuntime } from './backends/worktree.js';
import { PendingTurnQueue, type PendingEnqueueResult } from './pendingQueue.js';
import { resolveRuntime } from './registry.js';
import { getSecretBroker, prepareRuntimeChildEnv } from './secrets/secretBroker.js';
import {
  listRuntimeRecords,
  readRuntimeRecord,
  updateRuntimeRecord,
  type RuntimeInstanceRecord,
} from './state/runtimeStateStore.js';

/**
 * Real OS process liveness: `kill(pid, 0)` throws ESRCH when the process is
 * gone, EPERM when it exists but isn't ours (still alive). A null/0 pid is
 * treated as dead. Injectable everywhere it's used so tests stay hermetic.
 */
export function runtimePidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Durable statuses that imply a live owning process. */
const LIVE_STATUSES = new Set(['starting', 'ready', 'running']);

export interface RuntimeReconcileResult {
  /** Ids flipped dead-live → 'parked' (resumable). */
  parked: string[];
  /** Ids flipped to 'error' (worktree gone from disk — nothing to resume). */
  errored: string[];
}

/**
 * Boot reconcile: scan the durable records under `workspaceRoot` and repair
 * the ones a dead process left behind in a live-ish state. `process`-backend
 * records simply park (the conversation can be re-hosted). `worktree` records
 * park only when the tree still exists — verified by actually re-attaching
 * through the Phase-1 `attachWorktreeRuntime` primitive — and error otherwise.
 * `container` records become 'paused' when their docker ref survived (the
 * daemon may still hold the container; MC-A3) and error when it didn't.
 */
export function reconcileRuntimeRecords(
  workspaceRoot: string,
  isAlive: (pid: number | null | undefined) => boolean = runtimePidAlive,
): RuntimeReconcileResult {
  const result: RuntimeReconcileResult = { parked: [], errored: [] };
  for (const record of listRuntimeRecords(workspaceRoot)) {
    if (!LIVE_STATUSES.has(record.status)) continue;
    if (isAlive(record.pid)) continue; // still owned by a live process
    // MC-A3 — a dead-owner container record becomes 'paused' (the container's
    // suspended state), provided its docker ref survived: the daemon may well
    // still hold the container, so it stays re-attachable by id. Docker itself
    // is NOT consulted here — the next lifecycle action surfaces daemon truth.
    if (record.backend === 'container') {
      if (!record.container) {
        updateRuntimeRecord(workspaceRoot, record.id, { status: 'error', pid: null });
        result.errored.push(record.id);
        continue;
      }
      updateRuntimeRecord(workspaceRoot, record.id, { status: 'paused', pid: null });
      result.parked.push(record.id);
      continue;
    }
    // Dead owner: park the record (pid cleared — nobody owns it now).
    updateRuntimeRecord(workspaceRoot, record.id, { status: 'parked', pid: null });
    if (record.backend === 'worktree') {
      try {
        // Verification IS the re-attach primitive: it reads the parked record,
        // checks the persisted worktree ref, and throws when the tree is gone.
        attachWorktreeRuntime({ executeTurn: async () => '', workspaceRoot, id: record.id });
      } catch {
        updateRuntimeRecord(workspaceRoot, record.id, { status: 'error' });
        result.errored.push(record.id);
        continue;
      }
    }
    result.parked.push(record.id);
  }
  return result;
}

/** One row of `listRuntimes()`: the durable record + in-process liveness. */
export interface RuntimeListing extends RuntimeInstanceRecord {
  /** True when THIS manager holds the instance live (ready/running). */
  live: boolean;
}

export interface StartRuntimeOptions {
  /** Session key of the conversation the new runtime hosts. */
  sessionKey: string;
  /** Optional caller-assigned runtime id, used when clients queue before ready. */
  runtimeId?: string;
  /** Backend kind (default: the `cli.runtime.backend` knob). */
  kind?: string;
  launchCwd?: string;
  role?: string;
  model?: string;
  env?: Record<string, string>;
}

export interface RuntimeManagerOptions {
  /** Workspace whose durable runtime records this manager owns. */
  workspaceRoot: string;
  /** Turn-execution seam handed to every backend it creates/attaches. */
  executeTurn: RuntimeTurnExecutor;
  /** Cap on live instances (default: the `cli.runtime.maxLive` knob; 0 = uncapped). */
  maxLive?: number;
  /** Injectable pid-liveness for boot reconcile (tests). */
  isAlive?: (pid: number | null | undefined) => boolean;
  /** Per-runtime pending-turn cap while a backend is starting. */
  maxPendingMessages?: number;
}

interface LiveEntry {
  runtime: IAgentRuntime;
  /** Monotonic recency stamp — bumped on start/exec/resume; lowest = LRU. */
  seq: number;
}

export class RuntimeManager {
  private readonly workspaceRoot: string;
  private readonly executeTurn: RuntimeTurnExecutor;
  private readonly maxLive: number;
  private readonly isAlive: (pid: number | null | undefined) => boolean;

  /** Instances currently live (ready/running) in THIS process. */
  private readonly live = new Map<string, LiveEntry>();
  /** Instances whose backend start is in progress. */
  private readonly starting = new Map<string, IAgentRuntime>();
  /** In-process handles we parked (LRU or explicit pause) — resumable directly. */
  private readonly parked = new Map<string, IAgentRuntime>();
  private readonly pending: PendingTurnQueue;
  private seq = 0;

  constructor(options: RuntimeManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.executeTurn = options.executeTurn;
    this.maxLive = options.maxLive ?? getCliKnobs().runtime.maxLive;
    this.isAlive = options.isAlive ?? runtimePidAlive;
    this.pending = new PendingTurnQueue(options.maxPendingMessages ?? 50);
  }

  /** Repair records a dead process left live-ish. See `reconcileRuntimeRecords`. */
  reconcile(): RuntimeReconcileResult {
    return reconcileRuntimeRecords(this.workspaceRoot, this.isAlive);
  }

  /** How many instances are live (ready/running) in this process right now. */
  liveCount(): number {
    return this.live.size;
  }

  /** The live/parked in-process handle for `id`, if this manager holds one. */
  get(id: string): IAgentRuntime | null {
    return this.live.get(id)?.runtime ?? this.starting.get(id) ?? this.parked.get(id) ?? null;
  }

  /**
   * Start a new runtime, LRU-parking a live one first when the cap is full.
   * With `maxLive === 0` the cap never engages.
   */
  async start(options: StartRuntimeOptions): Promise<IAgentRuntime> {
    await this.makeRoomForOneMore();
    const runtime = resolveRuntime({ executeTurn: this.executeTurn, id: options.runtimeId }, options.kind);
    // MC-A5 — with `cli.runtime.jitSecrets` on, secret-shaped vars in the
    // child env are replaced by single-use short-TTL lease tokens redeemed at
    // point-of-use through the host broker. Default off → env untouched.
    const runtimeKnobs = getCliKnobs().runtime;
    const env = prepareRuntimeChildEnv(options.env, {
      jitSecrets: runtimeKnobs.jitSecrets,
      ttlMs: runtimeKnobs.jitSecretTtlMs,
      scope: `session:${options.sessionKey}`,
      isSecret: isSecretShapedEnvVar,
      broker: getSecretBroker(),
    });
    this.starting.set(runtime.id, runtime);
    try {
      await runtime.start({
        workspaceRoot: this.workspaceRoot,
        sessionKey: options.sessionKey,
        launchCwd: options.launchCwd,
        role: options.role,
        model: options.model,
        env,
      });
      this.starting.delete(runtime.id);
      this.trackLive(runtime);
      await this.flushPending(runtime.id);
    } catch (error) {
      this.starting.delete(runtime.id);
      throw error;
    }
    return runtime;
  }

  /** Execute a turn on a live instance (bumps its LRU recency). */
  async exec(id: string, turn: RuntimeTurn): Promise<RuntimeTurnResult> {
    const entry = this.live.get(id);
    if (!entry) throw new Error(`runtime ${id} is not live in this manager`);
    entry.seq = ++this.seq;
    return entry.runtime.exec(turn);
  }

  /** Queue a turn for a runtime that is not ready yet. */
  queueTurn(id: string, turn: RuntimeTurn): PendingEnqueueResult {
    return this.pending.enqueue(id, turn);
  }

  pendingCount(id: string): number {
    return this.pending.size(id);
  }

  /** Drain queued turns in arrival order once the runtime is ready. */
  async flushPending(id: string): Promise<RuntimeTurnResult[]> {
    const queued = this.pending.drain(id);
    const results: RuntimeTurnResult[] = [];
    for (const entry of queued) {
      results.push(await this.exec(id, entry.turn));
    }
    return results;
  }

  /** Explicitly park a live instance (its durable record becomes 'parked'). */
  async pause(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (!entry) throw new Error(`runtime ${id} is not live in this manager`);
    await entry.runtime.pause();
    this.live.delete(id);
    this.parked.set(id, entry.runtime);
  }

  /**
   * Bring a parked instance back to `ready`, LRU-parking another live instance
   * first when the cap is full. Resolution order: in-process handle → durable
   * `worktree` record (re-attach by path) → durable `process` record (re-host
   * a fresh in-process runtime bound to the same id).
   */
  async resume(id: string): Promise<IAgentRuntime> {
    const alreadyLive = this.live.get(id);
    if (alreadyLive) return alreadyLive.runtime; // idempotent

    await this.makeRoomForOneMore();

    let runtime = this.parked.get(id) ?? null;
    if (runtime) {
      await runtime.resume();
    } else {
      const record = readRuntimeRecord(this.workspaceRoot, id);
      if (!record) throw new Error(`no runtime record '${id}' under ${this.workspaceRoot}`);
      // Suspended states differ per backend: worktree/process park, a
      // container is 'paused' (docker keeps it frozen in place — MC-A3).
      if (record.status !== 'parked' && record.status !== 'paused') {
        throw new Error(`runtime ${id} is '${record.status}' — only parked/paused runtimes resume`);
      }
      if (record.backend === 'worktree') {
        runtime = attachWorktreeRuntime({ executeTurn: this.executeTurn, workspaceRoot: this.workspaceRoot, id });
        await runtime.resume();
      } else if (record.backend === 'container') {
        // Re-attach by durable docker ref, then `docker unpause` — the
        // container kept its full FS+process state while suspended.
        runtime = attachContainerRuntime({ executeTurn: this.executeTurn, workspaceRoot: this.workspaceRoot, id });
        await runtime.resume();
      } else {
        // Re-host: the process backend has no live state to thaw — a fresh
        // in-process runtime bound to the SAME durable id serves the parked
        // conversation (workspace/session identity comes from the record).
        runtime = createProcessRuntime({ executeTurn: this.executeTurn, id });
        await runtime.start({ workspaceRoot: record.workspaceRoot, sessionKey: record.sessionKey });
      }
    }
    // This process owns the instance now — future boot reconciles key off pid.
    updateRuntimeRecord(this.workspaceRoot, id, { pid: process.pid });
    this.parked.delete(id);
    this.trackLive(runtime);
    await this.flushPending(id);
    return runtime;
  }

  /** Dispose an instance (live, parked in-process, or durable-parked). */
  async dispose(id: string): Promise<void> {
    const held = this.live.get(id)?.runtime ?? this.parked.get(id) ?? null;
    this.live.delete(id);
    this.starting.delete(id);
    this.parked.delete(id);
    this.pending.drain(id);
    if (held) {
      await held.dispose();
      return;
    }
    const record = readRuntimeRecord(this.workspaceRoot, id);
    if (!record) return;
    if (record.backend === 'worktree' && record.status === 'parked') {
      // Re-attach so dispose runs the real teardown (recovery patch + removal).
      const runtime = attachWorktreeRuntime({ executeTurn: this.executeTurn, workspaceRoot: this.workspaceRoot, id });
      await runtime.dispose();
      return;
    }
    if (record.backend === 'container' && record.status === 'paused') {
      // MC-A3 — re-attach so dispose runs the real teardown (archive hook,
      // then `docker rm -f` of the suspended container).
      const runtime = attachContainerRuntime({ executeTurn: this.executeTurn, workspaceRoot: this.workspaceRoot, id });
      await runtime.dispose();
      return;
    }
    if (record.status !== 'disposed') {
      updateRuntimeRecord(this.workspaceRoot, id, { status: 'disposed' });
    }
  }

  /** Durable records + in-process liveness, for CLI/desktop surfaces. */
  listRuntimes(): RuntimeListing[] {
    return listRuntimeRecords(this.workspaceRoot).map((record) => ({
      ...record,
      live: this.live.has(record.id),
    }));
  }

  private trackLive(runtime: IAgentRuntime): void {
    this.live.set(runtime.id, { runtime, seq: ++this.seq });
  }

  /**
   * Enforce the cap BEFORE a start/resume adds one more live instance: park
   * the least-recently-used `ready` instance until there is room. `running`
   * instances (mid-turn) are never yanked; if the cap is full of them the
   * caller's start fails loudly rather than corrupting an in-flight turn.
   */
  private async makeRoomForOneMore(): Promise<void> {
    if (this.maxLive <= 0) return; // 0 = uncapped
    while (this.live.size >= this.maxLive) {
      const victim = this.lruReadyEntry();
      if (!victim) {
        throw new Error(
          `runtime cap reached (maxLive=${this.maxLive}) and every live instance is mid-turn — retry when one is ready`,
        );
      }
      await this.pause(victim);
    }
  }

  /** Id of the least-recently-used live instance currently `ready`. */
  private lruReadyEntry(): string | null {
    let lruId: string | null = null;
    let lruSeq = Number.POSITIVE_INFINITY;
    for (const [id, entry] of this.live) {
      if (entry.runtime.status() !== 'ready') continue;
      if (entry.seq < lruSeq) {
        lruSeq = entry.seq;
        lruId = id;
      }
    }
    return lruId;
  }
}

/**
 * Construct a manager AND run boot reconcile — the standard entrypoint for
 * CLI/desktop hosts: stale records are repaired before anything lists or
 * resumes them. The reconcile outcome rides along for surfacing/logging.
 */
export function createRuntimeManager(
  options: RuntimeManagerOptions,
): { manager: RuntimeManager; reconciled: RuntimeReconcileResult } {
  const manager = new RuntimeManager(options);
  const reconciled = manager.reconcile();
  return { manager, reconciled };
}

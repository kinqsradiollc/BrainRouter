/**
 * MC-A2 — the `worktree` runtime backend: the existing git-worktree child
 * isolation, promoted to a first-class `IAgentRuntime`.
 *
 * Nothing here reimplements worktree mechanics — every filesystem/git move
 * DELEGATES to the proven machinery in `worktree/worktreeIsolation.ts` (the
 * same code path orchestration's isolated children use):
 *
 *  - `start()`  → `prepareChildWorkspace(...)` provisions a detached worktree
 *    of the workspace's repo under `<brainrouter-home>/worktrees/…` (or the
 *    `cli.worktreeRoot` knob). Isolation is MANDATORY for this backend — mode
 *    `git-worktree` fails closed instead of silently running non-isolated.
 *  - `exec(turn)` → the injected `RuntimeTurnExecutor` receives a spec whose
 *    `workspaceRoot`/`launchCwd` point INSIDE the worktree, exactly like the
 *    resolved child workspace orchestration hands its children.
 *  - `dispose()` → `removeChildWorktree(...)` captures a full binary-safe
 *    recovery patch (the existing recovery-patch writer, persisted via
 *    `worktreePatchFile(...)`) when the tree is dirty, then removes the
 *    worktree. Capture-only — a runtime dispose never auto-applies work back.
 *  - `pause()` → parks the durable record and leaves the worktree ON DISK
 *    (~0 cost, full FS state kept). `resume()` re-attaches by path — same
 *    instance, or a fresh process via `attachWorktreeRuntime(...)` reading the
 *    parked record's persisted worktree ref.
 *
 * `status()` reflects disk truth: a runtime whose worktree vanished from under
 * it (external `rm -rf`, orphan GC, sibling prune) reports `error` instead of
 * pretending to be ready.
 */

import fs from 'node:fs';
import {
  prepareChildWorkspace,
  removeChildWorktree,
  worktreePatchFile,
  type ChildWorktreeIsolation,
} from '../../worktree/worktreeIsolation.js';
import type {
  IAgentRuntime,
  RuntimeSpec,
  RuntimeStatus,
  RuntimeTurn,
  RuntimeTurnExecutor,
  RuntimeTurnResult,
} from '../runtimeTypes.js';
import {
  createRuntimeRecord,
  newRuntimeInstanceId,
  readRuntimeRecord,
  updateRuntimeRecord,
} from '../state/runtimeStateStore.js';

export interface WorktreeRuntimeOptions {
  /** How the backend executes a turn. The executor receives the ISOLATED spec
   *  (workspaceRoot/launchCwd inside the worktree). */
  executeTurn: RuntimeTurnExecutor;
  /** Injectable id/clock for deterministic tests. */
  id?: string;
  now?: () => string;
}

export interface AttachWorktreeRuntimeOptions extends WorktreeRuntimeOptions {
  /** The PARENT workspace root the parked record lives under. */
  workspaceRoot: string;
  /** Id of the parked instance to re-attach. */
  id: string;
}

export class WorktreeAgentRuntime implements IAgentRuntime {
  public readonly id: string;
  public readonly kind = 'worktree' as const;

  private readonly executeTurn: RuntimeTurnExecutor;
  private readonly nowFn: () => string;
  private state: RuntimeStatus = 'starting';
  private spec: RuntimeSpec | null = null;
  private isolation: ChildWorktreeIsolation | null = null;
  private launchCwd: string | null = null;

  constructor(options: WorktreeRuntimeOptions) {
    this.executeTurn = options.executeTurn;
    this.id = options.id ?? newRuntimeInstanceId();
    this.nowFn = options.now ?? (() => new Date().toISOString());
  }

  /** Absolute path of the provisioned worktree (null before start). */
  get worktreeRoot(): string | null {
    return this.isolation?.worktreeRoot ?? null;
  }

  /**
   * Re-attach a PARKED worktree runtime by path in a fresh instance (possibly
   * a fresh process): reads the durable record, verifies the worktree still
   * exists on disk, and returns a `parked` runtime ready to `resume()`.
   */
  static attach(options: AttachWorktreeRuntimeOptions): WorktreeAgentRuntime {
    const record = readRuntimeRecord(options.workspaceRoot, options.id);
    if (!record) throw new Error(`no runtime record '${options.id}' under ${options.workspaceRoot}`);
    if (record.backend !== 'worktree') {
      throw new Error(`runtime ${options.id} is a '${record.backend}' instance, not 'worktree'`);
    }
    if (!record.worktree) throw new Error(`runtime ${options.id} has no persisted worktree ref`);
    if (record.status !== 'parked') {
      throw new Error(`runtime ${options.id} is '${record.status}' — only parked runtimes re-attach`);
    }
    if (!fs.existsSync(record.worktree.worktreeRoot)) {
      throw new Error(`runtime ${options.id} worktree missing at ${record.worktree.worktreeRoot}`);
    }
    const rt = new WorktreeAgentRuntime({ executeTurn: options.executeTurn, id: options.id, now: options.now });
    rt.spec = { workspaceRoot: record.workspaceRoot, sessionKey: record.sessionKey };
    rt.isolation = { kind: 'git-worktree', ...record.worktree };
    rt.launchCwd = record.worktree.worktreeRoot;
    rt.state = 'parked';
    return rt;
  }

  status(): RuntimeStatus {
    // Disk truth wins: a live-ish state with the worktree gone is an error.
    if ((this.state === 'ready' || this.state === 'running' || this.state === 'parked')
      && this.isolation && !fs.existsSync(this.isolation.worktreeRoot)) {
      return 'error';
    }
    return this.state;
  }

  async start(spec: RuntimeSpec): Promise<void> {
    if (this.spec) throw new Error(`runtime ${this.id} already started`);
    this.spec = spec;
    createRuntimeRecord(spec.workspaceRoot, {
      id: this.id,
      backend: this.kind,
      sessionKey: spec.sessionKey,
      status: 'starting',
      now: this.nowFn(),
    });
    try {
      // The SAME provisioning path orchestration's isolated children use.
      // mode 'git-worktree' fails closed (throws) when the workspace isn't a
      // git repo or `git worktree add` fails — this backend never degrades to
      // running non-isolated on the host tree.
      const resolution = prepareChildWorkspace({
        parentWorkspaceRoot: spec.workspaceRoot,
        parentLaunchCwd: spec.launchCwd ?? spec.workspaceRoot,
        childId: this.id,
        access: 'write',
        mode: 'git-worktree',
      });
      if (!resolution.isolated || !resolution.isolation) {
        throw new Error(resolution.notice ?? 'worktree isolation was not established');
      }
      this.isolation = resolution.isolation;
      this.launchCwd = resolution.launchCwd;
    } catch (error) {
      this.setState('error');
      throw error;
    }
    // Persist WHERE the runtime lives so a parked instance can be re-attached
    // by path across processes (and so boot reconcile can find it later).
    updateRuntimeRecord(
      spec.workspaceRoot,
      this.id,
      { worktree: { sourceRoot: this.isolation.sourceRoot, worktreeRoot: this.isolation.worktreeRoot } },
      this.nowFn(),
    );
    this.setState('ready');
  }

  async exec(turn: RuntimeTurn): Promise<RuntimeTurnResult> {
    const spec = this.requireStarted();
    const current = this.status(); // disk-aware
    if (current !== 'ready') {
      throw new Error(`runtime ${this.id} cannot exec while '${current}' (expected 'ready')`);
    }
    const isolation = this.isolation!;
    this.setState('running');
    try {
      // The executor sees the ISOLATED workspace — cwd inside the worktree —
      // mirroring the resolved child workspace orchestration hands children.
      const output = await this.executeTurn(turn, {
        ...spec,
        workspaceRoot: isolation.worktreeRoot,
        launchCwd: this.launchCwd ?? isolation.worktreeRoot,
      });
      this.setState('ready');
      return { output };
    } catch (error) {
      this.setState('error');
      throw error;
    }
  }

  /** Park the record; the worktree stays ON DISK (full FS state, ~0 cost). */
  async pause(): Promise<void> {
    this.requireStarted();
    if (this.state === 'parked') return; // idempotent
    const current = this.status();
    if (current !== 'ready') {
      throw new Error(`runtime ${this.id} cannot pause while '${current}' (expected 'ready')`);
    }
    this.setState('parked');
  }

  /** Re-attach by path: verify the parked worktree still exists, then serve. */
  async resume(): Promise<void> {
    this.requireStarted();
    if (this.state === 'ready') return; // idempotent
    if (this.state !== 'parked') {
      throw new Error(`runtime ${this.id} cannot resume while '${this.state}' (expected 'parked')`);
    }
    if (this.isolation && !fs.existsSync(this.isolation.worktreeRoot)) {
      this.setState('error');
      throw new Error(`runtime ${this.id} worktree missing at ${this.isolation.worktreeRoot}`);
    }
    this.setState('ready');
  }

  /**
   * Capture a recovery patch (when dirty), remove the worktree, mark disposed.
   * Reuses the existing recovery-patch writer — the full binary-safe patch
   * lands at `worktreePatchFile(parentRoot, id)`, so no work is ever lost to
   * teardown. Capture-only: dispose never applies changes back to the parent.
   */
  async dispose(): Promise<void> {
    if (this.state === 'disposed') return; // idempotent
    if (this.spec && this.isolation) {
      removeChildWorktree(this.isolation, {
        applyBack: false,
        patchFile: worktreePatchFile(this.spec.workspaceRoot, this.id),
      });
    }
    this.setState('disposed');
  }

  private requireStarted(): RuntimeSpec {
    if (!this.spec) throw new Error(`runtime ${this.id} not started`);
    return this.spec;
  }

  private setState(next: RuntimeStatus): void {
    this.state = next;
    if (this.spec) {
      updateRuntimeRecord(this.spec.workspaceRoot, this.id, { status: next }, this.nowFn());
    }
  }
}

export function createWorktreeRuntime(options: WorktreeRuntimeOptions): WorktreeAgentRuntime {
  return new WorktreeAgentRuntime(options);
}

/** Functional alias for `WorktreeAgentRuntime.attach` (see its doc). */
export function attachWorktreeRuntime(options: AttachWorktreeRuntimeOptions): WorktreeAgentRuntime {
  return WorktreeAgentRuntime.attach(options);
}

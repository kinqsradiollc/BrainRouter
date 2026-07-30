/**
 * MC-A3 — the `container` runtime backend: a Docker-hosted body for one agent
 * conversation, STRICTLY OPT-IN.
 *
 * Opt-in gates (both required — a typo can never land anyone in a container):
 *   1. `cli.runtime.backend: 'container'` — selects the backend.
 *   2. `cli.runtime.containerImage`       — names the image. There is NO
 *      default image and NOTHING is ever pulled automatically: the host disk
 *      is a constrained resource, so a locally-missing image fails with the
 *      exact `docker pull <image>` command for the user to run themselves.
 *
 * Mechanics — everything shells out to the `docker` CLI (deliberately no
 * docker SDK dependency; a missing CLI is a clear error, not a crash):
 *   - `start()`   → `docker run -d` with the workspace bind-mounted at
 *     /workspace, a per-instance session-key env, resource limits from
 *     `cli.runtime.container` (`--cpus`/`--memory`), and the label
 *     `brainrouter.runtime=<id>` so stray containers are attributable. The
 *     container idles (`sleep infinity`) — it is the durable, pausable body.
 *   - `status()`  → `docker inspect` truth wins for live-ish states: a
 *     container that vanished (or exited) under us reports `error` instead of
 *     pretending to be ready — same disk-truth stance as the worktree backend.
 *   - `pause()`/`resume()` → `docker pause`/`unpause` (the container is frozen
 *     in place at ~0 CPU with full FS+process state kept) + the durable
 *     record, so a paused instance survives the owning process and re-attaches
 *     via `attachContainerRuntime`.
 *   - `dispose()` → the MC-A6 archive hook first (best-effort snapshot of the
 *     mounted workspace's uncommitted work), then `docker rm -f`.
 *
 * HONEST SCOPE NOTE — `exec(turn)` is the delegation seam, exactly like the
 * other backends: the injected `RuntimeTurnExecutor` runs ON THE HOST with its
 * cwd at the bind-mount source, so file edits land inside the container's
 * mounted workspace. A full in-container agent loop (agent process living
 * inside the container, bridged over a loopback port) is a LATER phase; this
 * backend does not claim to provide it yet.
 *
 * COMMAND GUARD — container isolation is a perimeter around the workspace,
 * not a replacement for the per-command guard: commands the hosted agent runs
 * through the exec layer still route through the existing sandbox profiles
 * (`sandbox-exec`/`bwrap` in `exec/runtime/sandbox.ts`) and the layered exec
 * policy where applicable, exactly as they do for every other backend.
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getCliKnobs } from '../../config/config.js';
import { archiveWorkspace } from '../archive.js';
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
  type RuntimeContainerRef,
} from '../state/runtimeStateStore.js';

/** Where the workspace is bind-mounted inside the container. */
export const CONTAINER_WORKSPACE_MOUNT = '/workspace';

/** Env var carrying the per-instance session key into the container. */
export const CONTAINER_SESSION_KEY_ENV = 'BRAINROUTER_RUNTIME_SESSION_KEY';

export interface DockerCliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * The docker seam: one synchronous call = one `docker <args…>` invocation.
 * Production uses `createDockerCliRunner()` (spawnSync, 'docker' from PATH);
 * tests inject a recorder so NO test ever needs a docker daemon.
 */
export type DockerCliRunner = (args: string[]) => DockerCliResult;

/** Real runner: shells out to `docker`. An absent binary is `ok: false` with
 *  the spawn error message — callers turn that into the instructive error. */
export function createDockerCliRunner(): DockerCliRunner {
  return (args: string[]) => {
    const result = spawnSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.error?.message ?? '',
    };
  };
}

export interface ContainerRuntimeOptions {
  /** How the backend executes a turn (host-side seam — see the scope note). */
  executeTurn: RuntimeTurnExecutor;
  /** Injectable id/clock for deterministic tests. */
  id?: string;
  now?: () => string;
  /** Injectable docker CLI (tests: a recorded-args fake; default: real CLI). */
  docker?: DockerCliRunner;
  /** Override `cli.runtime.containerImage` (tests / programmatic callers). */
  image?: string;
  /** Override `cli.runtime.container.cpus` (0 = no limit). */
  cpus?: number;
  /** Override `cli.runtime.container.memory` ('' = no limit). */
  memory?: string;
}

export interface AttachContainerRuntimeOptions extends ContainerRuntimeOptions {
  /** The workspace root the paused record lives under. */
  workspaceRoot: string;
  /** Id of the paused instance to re-attach. */
  id: string;
}

export class ContainerAgentRuntime implements IAgentRuntime {
  public readonly id: string;
  public readonly kind = 'container' as const;

  private readonly executeTurn: RuntimeTurnExecutor;
  private readonly nowFn: () => string;
  private readonly docker: DockerCliRunner;
  private readonly imageOverride?: string;
  private readonly cpusOverride?: number;
  private readonly memoryOverride?: string;
  private state: RuntimeStatus = 'starting';
  private spec: RuntimeSpec | null = null;
  private container: RuntimeContainerRef | null = null;

  constructor(options: ContainerRuntimeOptions) {
    this.executeTurn = options.executeTurn;
    this.id = options.id ?? newRuntimeInstanceId();
    this.nowFn = options.now ?? (() => new Date().toISOString());
    this.docker = options.docker ?? createDockerCliRunner();
    this.imageOverride = options.image;
    this.cpusOverride = options.cpus;
    this.memoryOverride = options.memory;
  }

  /** Docker container id (null before `docker run` succeeds). */
  get containerId(): string | null {
    return this.container?.containerId ?? null;
  }

  /**
   * Re-attach a PAUSED container runtime by durable record — possibly from a
   * fresh process. The docker container itself kept the full FS+process state
   * frozen; this just rebinds an in-process handle to it. Pure record read —
   * docker is only consulted by the next lifecycle action.
   */
  static attach(options: AttachContainerRuntimeOptions): ContainerAgentRuntime {
    const record = readRuntimeRecord(options.workspaceRoot, options.id);
    if (!record) throw new Error(`no runtime record '${options.id}' under ${options.workspaceRoot}`);
    if (record.backend !== 'container') {
      throw new Error(`runtime ${options.id} is a '${record.backend}' instance, not 'container'`);
    }
    if (!record.container) throw new Error(`runtime ${options.id} has no persisted container ref`);
    if (record.status !== 'paused') {
      throw new Error(`runtime ${options.id} is '${record.status}' — only paused containers re-attach`);
    }
    const rt = new ContainerAgentRuntime({ ...options });
    rt.spec = { workspaceRoot: record.workspaceRoot, sessionKey: record.sessionKey };
    rt.container = record.container;
    rt.state = 'paused';
    return rt;
  }

  status(): RuntimeStatus {
    // Docker truth wins for live-ish states: a container removed or exited
    // under us is an error, not a phantom 'ready'.
    if ((this.state === 'ready' || this.state === 'running' || this.state === 'paused') && this.container) {
      const inspect = this.docker(['inspect', '--format', '{{.State.Status}}', this.container.containerId]);
      if (!inspect.ok) return 'error';
      const live = inspect.stdout.trim();
      if (live === 'exited' || live === 'dead' || live === 'removing') return 'error';
    }
    return this.state;
  }

  async start(spec: RuntimeSpec): Promise<void> {
    if (this.spec) throw new Error(`runtime ${this.id} already started`);

    // Opt-in gate FIRST: no image configured means the user never opted in —
    // fail before even probing for docker.
    const knobs = getCliKnobs().runtime;
    const image = (this.imageOverride ?? knobs.containerImage).trim();
    if (!image) {
      throw new Error(
        'the container runtime backend is strictly opt-in: set cli.runtime.containerImage in config.json '
        + '(there is no default image and images are never pulled automatically)',
      );
    }

    // The docker CLI must exist — clear error instead of a spawn crash.
    const probe = this.docker(['--version']);
    if (!probe.ok) {
      throw new Error(
        `the container runtime backend requires the docker CLI on PATH (${probe.stderr.trim() || 'docker not found'}) `
        + "— install Docker or set cli.runtime.backend back to 'process'",
      );
    }

    // NO automatic pulls — a missing image is an instructive error with the
    // exact command, never a multi-GB surprise download on a constrained disk.
    const imagePresent = this.docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    if (!imagePresent.ok) {
      throw new Error(
        `container image '${image}' is not available locally and automatic pulls are disabled `
        + `(the host disk is a constrained resource) — run 'docker pull ${image}' yourself, then retry`,
      );
    }

    this.spec = spec;
    createRuntimeRecord(spec.workspaceRoot, {
      id: this.id,
      backend: this.kind,
      sessionKey: spec.sessionKey,
      status: 'starting',
      now: this.nowFn(),
    });

    const cpus = this.cpusOverride ?? knobs.container.cpus;
    const memory = this.memoryOverride ?? knobs.container.memory;
    const args = [
      'run', '-d',
      '--name', `brainrouter-rt-${this.id}`,
      '--label', `brainrouter.runtime=${this.id}`,
      '-v', `${spec.workspaceRoot}:${CONTAINER_WORKSPACE_MOUNT}`,
      '-w', containerCwd(spec),
      '-e', `${CONTAINER_SESSION_KEY_ENV}=${spec.sessionKey}`,
      ...Object.entries(spec.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      ...(cpus > 0 ? ['--cpus', String(cpus)] : []),
      ...(memory ? ['--memory', memory] : []),
      image,
      // The container is the durable, pausable BODY; it idles until the
      // in-container agent loop lands in a later phase (see scope note).
      'sleep', 'infinity',
    ];
    const run = this.docker(args);
    if (!run.ok) {
      this.setState('error');
      throw new Error(`docker run failed for runtime ${this.id}: ${run.stderr.trim() || 'unknown docker error'}`);
    }
    this.container = { containerId: run.stdout.trim(), image };
    updateRuntimeRecord(spec.workspaceRoot, this.id, { container: this.container }, this.nowFn());
    this.setState('ready');
  }

  async exec(turn: RuntimeTurn): Promise<RuntimeTurnResult> {
    const spec = this.requireStarted();
    const current = this.status(); // docker-aware
    if (current !== 'ready') {
      throw new Error(`runtime ${this.id} cannot exec while '${current}' (expected 'ready')`);
    }
    this.setState('running');
    try {
      // Host-side seam with cwd at the bind-mount source: edits land in the
      // container's mounted workspace. Commands still pass through the exec
      // layer's sandbox profiles/policy — see the command-guard note above.
      const output = await this.executeTurn(turn, {
        ...spec,
        workspaceRoot: spec.workspaceRoot,
        launchCwd: spec.launchCwd ?? spec.workspaceRoot,
      });
      this.setState('ready');
      return { output };
    } catch (error) {
      this.setState('error');
      throw error;
    }
  }

  /** Freeze the container in place (`docker pause`): full FS+process state
   *  kept at ~0 CPU, durable record marked `paused`. */
  async pause(): Promise<void> {
    this.requireStarted();
    if (this.state === 'paused') return; // idempotent
    const current = this.status();
    if (current !== 'ready') {
      throw new Error(`runtime ${this.id} cannot pause while '${current}' (expected 'ready')`);
    }
    const result = this.docker(['pause', this.container!.containerId]);
    if (!result.ok) {
      this.setState('error');
      throw new Error(`docker pause failed for runtime ${this.id}: ${result.stderr.trim()}`);
    }
    this.setState('paused');
  }

  /** Thaw the container (`docker unpause`). Tolerates "not paused" — e.g. a
   *  re-attach after the daemon kept the container running. */
  async resume(): Promise<void> {
    this.requireStarted();
    if (this.state === 'ready') return; // idempotent
    if (this.state !== 'paused') {
      throw new Error(`runtime ${this.id} cannot resume while '${this.state}' (expected 'paused')`);
    }
    const result = this.docker(['unpause', this.container!.containerId]);
    if (!result.ok && !/is not paused/i.test(result.stderr)) {
      this.setState('error');
      throw new Error(`docker unpause failed for runtime ${this.id}: ${result.stderr.trim()}`);
    }
    this.setState('ready');
  }

  /**
   * MC-A6 archive hook first (best-effort snapshot of the mounted workspace's
   * uncommitted work — never blocks teardown), then `docker rm -f`. A
   * container that is already gone counts as removed (idempotent teardown).
   */
  async dispose(): Promise<void> {
    if (this.state === 'disposed') return; // idempotent
    if (this.spec && this.container) {
      if (getCliKnobs().runtime.archiveOnDispose) {
        try {
          archiveWorkspace({
            id: this.id,
            workspaceRoot: this.spec.workspaceRoot,
            // The bind mount means the work already lives on the host tree;
            // the archive is the same durable snapshot worktree disposal gets.
            treeRoot: this.spec.workspaceRoot,
            sessionKey: this.spec.sessionKey,
            now: this.nowFn,
          });
        } catch { /* archiving is best-effort — never block teardown */ }
      }
      const result = this.docker(['rm', '-f', this.container.containerId]);
      if (!result.ok && !/no such container/i.test(result.stderr)) {
        throw new Error(`docker rm failed for runtime ${this.id}: ${result.stderr.trim()}`);
      }
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

/** Launch cwd mapped INTO the container: `/workspace` or a subdir of it. */
function containerCwd(spec: RuntimeSpec): string {
  if (!spec.launchCwd || spec.launchCwd === spec.workspaceRoot) return CONTAINER_WORKSPACE_MOUNT;
  const rel = path.relative(spec.workspaceRoot, spec.launchCwd);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return CONTAINER_WORKSPACE_MOUNT;
  return path.posix.join(CONTAINER_WORKSPACE_MOUNT, ...rel.split(path.sep));
}

export function createContainerRuntime(options: ContainerRuntimeOptions): ContainerAgentRuntime {
  return new ContainerAgentRuntime(options);
}

/** Functional alias for `ContainerAgentRuntime.attach` (see its doc). */
export function attachContainerRuntime(options: AttachContainerRuntimeOptions): ContainerAgentRuntime {
  return ContainerAgentRuntime.attach(options);
}

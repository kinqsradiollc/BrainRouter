/**
 * MC-A1 — the `process` runtime backend: today's in-process host execution,
 * wrapped to satisfy `IAgentRuntime` with ZERO behavior change.
 *
 * It does not rewrite (or even touch) the agent loop. Turn execution is a
 * delegated `RuntimeTurnExecutor`; production wiring adapts the existing
 * `Agent.runTurn` via `agentTurnExecutor(...)` below, and the default
 * CLI/desktop path is free to keep calling the Agent directly until a caller
 * opts into routing through the port.
 *
 * pause()/resume() for an in-process runtime cannot freeze live state, so
 * pause PARKS the durable instance record (status `parked`) — cheap, survives
 * the process, and gives MC-A4's boot reconcile something to resume from.
 */

import type { Agent, RunTurnCallbacks } from '../../agent/agent.js';
import type {
  IAgentRuntime,
  RuntimeSpec,
  RuntimeStatus,
  RuntimeTurn,
  RuntimeTurnExecutor,
  RuntimeTurnResult,
} from '../runtimeTypes.js';
import { createRuntimeRecord, newRuntimeInstanceId, updateRuntimeRecord } from '../state/runtimeStateStore.js';

/** Silent callbacks for port-driven turns — same shape headless callers use. */
const SILENT_CALLBACKS: RunTurnCallbacks = {
  onStatusUpdate: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
};

/**
 * Adapt an existing `Agent` to the runtime-plane executor seam. This is the
 * ONLY production bridge between the port and the agent loop: a one-line
 * delegation to `Agent.runTurn`, so behavior is byte-identical to calling the
 * agent directly.
 */
export function agentTurnExecutor(agent: Pick<Agent, 'runTurn'>): RuntimeTurnExecutor {
  return (turn) => agent.runTurn(turn.prompt, SILENT_CALLBACKS, { hiddenPrompt: turn.hidden });
}

export interface ProcessRuntimeOptions {
  /** How the backend executes a turn. Production: `agentTurnExecutor(agent)`. */
  executeTurn: RuntimeTurnExecutor;
  /** Injectable id/clock for deterministic tests. */
  id?: string;
  now?: () => string;
}

export class ProcessAgentRuntime implements IAgentRuntime {
  public readonly id: string;
  public readonly kind = 'process' as const;

  private readonly executeTurn: RuntimeTurnExecutor;
  private readonly nowFn: () => string;
  private state: RuntimeStatus = 'starting';
  private spec: RuntimeSpec | null = null;

  constructor(options: ProcessRuntimeOptions) {
    this.executeTurn = options.executeTurn;
    this.id = options.id ?? newRuntimeInstanceId();
    this.nowFn = options.now ?? (() => new Date().toISOString());
  }

  status(): RuntimeStatus {
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
    // The process backend has no cold start — the host process IS the runtime.
    this.setState('ready');
  }

  async exec(turn: RuntimeTurn): Promise<RuntimeTurnResult> {
    const spec = this.requireStarted();
    if (this.state !== 'ready') {
      throw new Error(`runtime ${this.id} cannot exec while '${this.state}' (expected 'ready')`);
    }
    this.setState('running');
    try {
      const output = await this.executeTurn(turn, spec);
      this.setState('ready');
      return { output };
    } catch (error) {
      this.setState('error');
      throw error;
    }
  }

  /** Park the durable record — the in-process analogue of a live pause. */
  async pause(): Promise<void> {
    this.requireStarted();
    if (this.state === 'parked') return; // idempotent
    if (this.state !== 'ready') {
      throw new Error(`runtime ${this.id} cannot pause while '${this.state}' (expected 'ready')`);
    }
    this.setState('parked');
  }

  async resume(): Promise<void> {
    this.requireStarted();
    if (this.state === 'ready') return; // idempotent
    if (this.state !== 'parked') {
      throw new Error(`runtime ${this.id} cannot resume while '${this.state}' (expected 'parked')`);
    }
    this.setState('ready');
  }

  async dispose(): Promise<void> {
    if (this.state === 'disposed') return; // idempotent
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

export function createProcessRuntime(options: ProcessRuntimeOptions): ProcessAgentRuntime {
  return new ProcessAgentRuntime(options);
}

/**
 * MC-A1 — the agent RUNTIME PLANE port (seam extraction, zero behavior change).
 *
 * `IAgentRuntime` is the contract every runtime backend satisfies: a place an
 * agent conversation RUNS, with a uniform lifecycle (`start` → `exec`* →
 * `pause`/`resume` → `dispose`). Today there is exactly one backend —
 * `process` (the in-process host runtime the CLI/desktop have always used) —
 * and the default execution path may keep calling the Agent directly; the
 * port exists so isolated backends (`worktree`, later `container`/`remote`)
 * can slot in behind `resolveRuntime(...)` without touching the agent loop.
 *
 * Nothing here rewrites `agent/` machinery: backends DELEGATE turn execution
 * to an injected `RuntimeTurnExecutor` (production: a thin wrapper over
 * `Agent.runTurn`; tests: a fake).
 */

import type { RuntimeBackendKind } from '../config/configTypes.js';

export type { RuntimeBackendKind } from '../config/configTypes.js';

/**
 * Lifecycle state of a runtime instance.
 *
 *   starting → ready ⇄ running
 *   ready → paused   (live backend suspended in place — container/pod later)
 *   ready → parked   (durably checkpointed at ~0 cost; the `process` backend's
 *                     pause semantics — the task record survives, no live state)
 *   any   → disposed (terminal)
 *   any   → error    (terminal-ish; dispose still allowed)
 */
export type RuntimeStatus =
  | 'starting'
  | 'ready'
  | 'running'
  | 'paused'
  | 'parked'
  | 'disposed'
  | 'error';

/** What a backend needs to bring a runtime up for one conversation. */
export interface RuntimeSpec {
  /** Absolute workspace root the agent operates in. */
  workspaceRoot: string;
  /** Session key of the conversation this runtime hosts. */
  sessionKey: string;
  /** Optional role hint (orchestration role the hosted agent plays). */
  role?: string;
  /** Optional model hint (per-role model routing still applies downstream). */
  model?: string;
  /** Extra environment for isolated backends. The `process` backend ignores
   *  this (it shares the host env by definition). */
  env?: Record<string, string>;
}

/** One unit of work handed to a runtime — a single conversation turn. */
export interface RuntimeTurn {
  prompt: string;
  /** Mirrors `runTurn`'s hiddenPrompt opt — synthetic/system-injected turns. */
  hidden?: boolean;
}

export interface RuntimeTurnResult {
  /** The hosted agent's final answer for the turn. */
  output: string;
}

/**
 * The delegation seam: how a backend actually executes a turn. Production
 * wiring adapts the existing `Agent.runTurn` (see `agentTurnExecutor` in
 * `backends/process.ts`); contract tests inject a fake. Keeping execution
 * injected is what makes MC-A1 a ZERO-behavior-change extraction — no agent
 * loop code moves or changes.
 */
export type RuntimeTurnExecutor = (turn: RuntimeTurn, spec: RuntimeSpec) => Promise<string>;

/**
 * The runtime-plane port. One instance = one conversation's "body".
 *
 * Contract (verified by the port contract test):
 *  - `start` may be called once; it moves `starting` → `ready`.
 *  - `exec` is only legal while `ready`; it is `running` for the duration and
 *    returns to `ready` (or `error` when the executor throws).
 *  - `pause`/`resume` round-trip `ready` ⇄ `paused`|`parked` (backend picks
 *    which suspended state it supports).
 *  - `dispose` is terminal and idempotent.
 */
export interface IAgentRuntime {
  /** Stable instance id (also the durable state-record id). */
  readonly id: string;
  /** Which backend this instance belongs to. */
  readonly kind: RuntimeBackendKind;
  start(spec: RuntimeSpec): Promise<void>;
  status(): RuntimeStatus;
  pause(): Promise<void>;
  resume(): Promise<void>;
  dispose(): Promise<void>;
  exec(turn: RuntimeTurn): Promise<RuntimeTurnResult>;
}

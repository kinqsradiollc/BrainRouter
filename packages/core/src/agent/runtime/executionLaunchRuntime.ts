import type { ExecutionIntentRecord } from '@kinqs/brainrouter-types/agent';
import type { ExecutionDispatchReceipt } from '../../orchestration/execution/authority.js';
import type { Agent } from '../agent.js';

/** Internal-only result of consuming one reviewed launch inside runTurn. */
export interface ExecutionLaunchAuthorization {
  runId: string;
  parentExecutionId: string;
  authorityGeneration: number;
  authorityPolicyFingerprint: string;
  record: ExecutionIntentRecord;
  dispatchArgs: Readonly<Record<string, unknown>>;
  dispatchReceipt: ExecutionDispatchReceipt;
}

export interface ExecutionLaunchRuntime {
  recordMcpInventory(tools: readonly unknown[]): void;
  assertPendingCurrent(): void;
  preflight(
    toolName: 'run_workflow' | 'run_workflow_graph',
    args: Record<string, unknown>,
  ): void;
  authorize(
    toolName: 'run_workflow' | 'run_workflow_graph',
    args: Record<string, unknown>,
  ): ExecutionLaunchAuthorization;
  rejectPending(): void;
  reject(launch: Pick<ExecutionLaunchAuthorization, 'dispatchReceipt'>): void;
  /** Post-dispatch lease check; unlike assertCurrent, it skips the fresh-run collision guard. */
  assertLeaseCurrent(
    launch: Pick<
      ExecutionLaunchAuthorization,
      | 'parentExecutionId'
      | 'authorityGeneration'
      | 'authorityPolicyFingerprint'
      | 'record'
      | 'dispatchArgs'
    >,
  ): void;
  assertCurrent(
    launch: Pick<
      ExecutionLaunchAuthorization,
      | 'parentExecutionId'
      | 'authorityGeneration'
      | 'authorityPolicyFingerprint'
      | 'record'
      | 'dispatchArgs'
    >,
  ): void;
}

const runtimes = new WeakMap<Agent, ExecutionLaunchRuntime>();

/** Agent constructor wiring; deliberately omitted from every public barrel. */
export function registerExecutionLaunchRuntime(
  agent: Agent,
  runtime: ExecutionLaunchRuntime,
): void {
  if (runtimes.has(agent)) throw new Error('execution launch runtime is already registered');
  runtimes.set(agent, Object.freeze(runtime));
}

/** Internal turn-loop lookup. Public hosts never receive the receipt authority. */
export function executionLaunchRuntimeFor(agent: Agent): ExecutionLaunchRuntime {
  const runtime = runtimes.get(agent);
  if (!runtime) throw new Error('execution launch runtime is not registered');
  return runtime;
}

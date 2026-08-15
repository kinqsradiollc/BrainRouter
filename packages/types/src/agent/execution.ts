/**
 * Serializable, host-neutral records for explicitly authorized execution.
 *
 * These records are audit data, not bearer credentials. Core keeps runtime
 * authority on an opaque object identity that cannot survive serialization.
 */

export type ExecutionIntentSource =
  | "user-command"
  | "reviewed-ui"
  | "authorized-workflow";

export interface PhasePlanExecutionIntentTargetV1 {
  topology: "phase-plan";
  slug: string;
  background: boolean;
  resume: string | null;
  template: string | null;
  definitionDigest: string;
}

export interface WorkflowGraphExecutionIntentTargetV1 {
  topology: "workflow-graph";
  graphId: string;
  graphRevision: string | null;
  definitionDigest: string;
}

export type ExecutionIntentTargetV1 =
  | PhasePlanExecutionIntentTargetV1
  | WorkflowGraphExecutionIntentTargetV1;

export interface ExecutionIntentRecordV1 {
  version: 1;
  workspaceRoot: string;
  sessionKey: string;
  userId: string;
  source: ExecutionIntentSource;
  requestId: string;
  turnId: string;
  issuedAt: string;
  expiresAt: string;
  target: ExecutionIntentTargetV1;
}

/** Current record alias used by durable run ledgers. */
export type ExecutionIntentRecord = ExecutionIntentRecordV1;

declare const executionIntentHandleBrand: unique symbol;

/**
 * Process-local bearer identity. A clone or decoded record is intentionally
 * not assignable and, even after a type assertion, has no runtime authority.
 */
export interface ExecutionIntentHandle {
  readonly [executionIntentHandleBrand]: true;
}

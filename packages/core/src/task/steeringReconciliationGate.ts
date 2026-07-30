/**
 * Pure tool-gate decision for pending steering reconciliation.
 *
 * The turn loop owns enforcement and tracing; this module owns only the
 * deterministic allow/deny rule so it can be tested without an Agent runtime.
 */
import type { PendingSteeringConstraint } from './steeringReceiptStore.js';

export interface SteeringToolGateDecision {
  allowed: boolean;
  reason?: string;
}

export function evaluateSteeringToolGate(
  constraint: PendingSteeringConstraint | null,
  toolName: string,
  args: Record<string, unknown>,
): SteeringToolGateDecision {
  if (!constraint) return { allowed: true };
  if (constraint.phase === 'classify') {
    return toolName === 'reconcile_steer'
      ? { allowed: true }
      : {
          allowed: false,
          reason: `Steering receipt "${constraint.receiptId}" must be classified with reconcile_steer before tool "${toolName}".`,
        };
  }
  const matchesPlanRevision =
    toolName === 'update_plan' &&
    String(args.steeringReceiptId ?? '') === constraint.receiptId;
  return matchesPlanRevision
    ? { allowed: true }
    : {
        allowed: false,
        reason: `Steering receipt "${constraint.receiptId}" requires update_plan with the matching steeringReceiptId before tool "${toolName}".`,
      };
}

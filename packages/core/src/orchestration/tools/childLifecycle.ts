/**
 * Child execution terminal-state projection.
 *
 * Spawn and continuation paths use the same receipt builder. Parent
 * interruption persists an explicit interrupted state, emits one host receipt,
 * and queues the same outcome for detached-result delivery.
 */

import type { ChildExecutionReceipt } from '@kinqs/brainrouter-agent-protocol';
import { enqueueCompletion } from '../../session/completion/completionInbox.js';
import {
  getSession,
  updateSession,
  type ChildSessionRecord,
} from '../session/orchestrator.js';
import type { OrchestrationContext } from './context.js';

export const CHILD_INTERRUPTED_SUMMARY =
  'Child execution interrupted by the parent request.';

export function createChildExecutionReceipt(
  receipt: ChildExecutionReceipt,
): ChildExecutionReceipt {
  return receipt;
}

export function childTurnWasInterrupted(
  agent: { interruptSignal?: AbortSignal },
): boolean {
  return agent.interruptSignal?.aborted === true;
}

export function finalizeInterruptedChild(input: {
  ctx: OrchestrationContext;
  record: ChildSessionRecord;
  role: string;
  output?: string;
  reportCompletionToParent: boolean;
  rejectPreparedDelegation?: () => void;
  completedAt?: string;
}): ChildSessionRecord {
  const current = getSession(input.ctx.workspaceRoot, input.record.id);
  if (
    current
    && current.status !== 'pending'
    && current.status !== 'running'
  ) {
    return current;
  }
  const completedAt = input.completedAt ?? new Date().toISOString();
  input.rejectPreparedDelegation?.();
  const next = updateSession(input.ctx.workspaceRoot, input.record.id, {
    status: 'interrupted',
    completedAt,
    error: undefined,
    finalOutput: input.output || CHILD_INTERRUPTED_SUMMARY,
  });
  const receipt = createChildExecutionReceipt({
    childId: input.record.id,
    role: input.role,
    status: 'interrupted',
    completedAt,
    summary: CHILD_INTERRUPTED_SUMMARY,
  });
  input.ctx.onChildComplete?.(receipt);
  if (input.reportCompletionToParent) {
    enqueueCompletion(input.ctx.parentSessionKey, {
      kind: 'agent',
      id: input.record.id,
      status: 'interrupted',
      label: input.role,
      summary: CHILD_INTERRUPTED_SUMMARY,
      completedAt,
    });
  }
  return next;
}

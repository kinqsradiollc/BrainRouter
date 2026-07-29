/**
 * Host-neutral child execution receipts.
 *
 * A terminal child produces exactly one receipt. CLI, Desktop, and other
 * presentation heads may style it differently but must preserve this payload
 * verbatim, including interrupted outcomes and worktree recovery details.
 */

export type ChildExecutionStatus =
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface ChildExecutionReceipt {
  childId: string;
  role: string;
  status: ChildExecutionStatus;
  completedAt: string;
  summary?: string;
  preview?: string;
  error?: string;
  worktree?: {
    changedFiles?: number;
    applied?: boolean;
    patchPath?: string;
    applyError?: string;
    heldForReview?: boolean;
  };
}

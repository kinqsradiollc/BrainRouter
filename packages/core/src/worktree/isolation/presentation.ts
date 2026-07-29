/**
 * Pure presentation for worktree recovery and merge-back outcomes.
 *
 * Extracted verbatim from worktreeIsolation.ts so host adapters do not own
 * user-facing lifecycle policy.
 */
import type {
  RemoveChildWorktreeResult,
  WorktreeHoldReason,
} from './contracts.js';

/**
 * BUILD-LOOP P2.5 (0.4.12) — the one-line worktree-merge notice appended to a
 * child's completion preview.
 */
export function mergeBackLine(
  cleanup: Pick<RemoveChildWorktreeResult, 'changedFiles' | 'applied' | 'applyError'>,
  childId: string,
  hold?: WorktreeHoldReason | null,
): string {
  const n = cleanup.changedFiles ?? 0;
  if (!n) return '';
  if (hold === 'review') {
    return `\n\n— worktree: ${n} file(s) HELD for review (cli.worktreeMergeReview) — inspect \`/agents diff ${childId}\`, apply \`/agents diff ${childId} apply\``;
  }
  if (hold === 'fanout') {
    return `\n\n— worktree: ${n} file(s) HELD — the build loop's synthesis gate decides the merge (recover with \`/agents diff ${childId}\` if needed)`;
  }
  return cleanup.applied
    ? `\n\n— worktree: ${n} file(s) merged into your tree`
    : `\n\n— worktree: ${n} file(s) NOT merged (${cleanup.applyError ?? 'conflict'}) — recover with /agents diff ${childId}`;
}

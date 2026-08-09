/**
 * The prompt for reviewing UNCOMMITTED work in a workspace — the local pass the
 * desktop Review panel runs before a commit or PR.
 *
 * It lived inline in the desktop host, which is why its copy of the grounding
 * rule drifted from the bot's. Assembling it here makes it testable without an
 * Electron process and puts every reviewing surface on one definition.
 *
 * This is NOT routed onto the code-review lens. That lens explicitly hands
 * vulnerabilities to a separate reviewer, and this is the only local security
 * pass that exists — reusing it would silently drop security from the pre-commit
 * review with nothing on any surface to say so.
 */
import { REVIEW_OUTPUT_CONTRACT } from './reviewFindings.js';
import { fenceUntrustedReviewEvidence } from './reviewEvidenceBoundary.js';
import { buildGroundingClause } from './reviewGrounding.js';
import { redactReviewSourceText } from './sourceSafety.js';

const MAX_REPOSITORY_CONTEXT_CHARS = 24_000;

export interface WorkingTreeReviewPromptInput {
  /** Fenced REVIEW.md evidence rendered by `buildReviewInstructionBlock`; empty when absent. */
  reviewInstructions?: string;
  /** Deterministic blast-radius block; empty when the graph has nothing to say. */
  changeContext?: string;
  /** The working-tree diff, already capped by the caller. */
  diff: string;
}

/**
 * Assemble the working-tree review prompt.
 *
 * Any REVIEW.md text leads only as explicitly fenced repository evidence. It
 * cannot override the trusted contract because ADR-033 keeps all checkout
 * content untrusted, including prose that describes itself as policy.
 */
export function buildWorkingTreeReviewPrompt(input: WorkingTreeReviewPromptInput): string {
  const instructions = input.reviewInstructions ?? '';
  const redactedContext = redactReviewSourceText(input.changeContext ?? '');
  const changeContext = redactedContext.length > MAX_REPOSITORY_CONTEXT_CHARS
    ? `${redactedContext.slice(0, MAX_REPOSITORY_CONTEXT_CHARS)}\n[repository context truncated]`
    : redactedContext;
  return `${instructions}You are reviewing the uncommitted changes in this workspace before a commit/PR. `
    + 'Focus on real bugs, security issues, and performance problems introduced by the diff. Be concise.\n'
    + `\n${buildGroundingClause('read-only-tools')}\n`
    + `\n${changeContext ? fenceUntrustedReviewEvidence('repository_context', changeContext) : ''}`
    + `Diff evidence:\n${fenceUntrustedReviewEvidence('diff', input.diff)}`
    + `\n${REVIEW_OUTPUT_CONTRACT}`;
}

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
import { buildGroundingClause } from './reviewGrounding.js';

export interface WorkingTreeReviewPromptInput {
  /** REVIEW.md rendered by `buildReviewInstructionBlock`; empty when absent. */
  reviewInstructions?: string;
  /** Deterministic blast-radius block; empty when the graph has nothing to say. */
  changeContext?: string;
  /** The working-tree diff, already capped by the caller. */
  diff: string;
}

/**
 * Assemble the working-tree review prompt.
 *
 * The repo owner's REVIEW.md leads, ahead of the default contract, because it
 * overrides severity calibration, skip rules and nit caps — a policy that
 * arrives after the rule it is meant to override does not override it.
 */
export function buildWorkingTreeReviewPrompt(input: WorkingTreeReviewPromptInput): string {
  const instructions = input.reviewInstructions ?? '';
  const changeContext = input.changeContext ?? '';
  return `${instructions}You are reviewing the uncommitted changes in this workspace before a commit/PR. `
    + 'Focus on real bugs, security issues, and performance problems introduced by the diff. Be concise.\n'
    + `\n${buildGroundingClause('read-only-tools')}\n`
    + `\n${changeContext ? `${changeContext}\n\n` : ''}Diff:\n${input.diff}\n`
    + `\n${REVIEW_OUTPUT_CONTRACT}`;
}

/**
 * CC-P6.5 — verification-before-done gate (0.4.15 thread B).
 *
 * When a turn MUTATES the workspace (file edits / writes / patches, or a
 * mutating shell command) it should not end claiming success without running
 * SOME verification — a build, a test, a typecheck — at least once. The strong
 * reference agents treat "I changed code, did I prove it works?" as a contract;
 * weak models happily declare "done, all fixed" having run nothing. This is the
 * exact counterpart of the `verificationRate` metric in the behavior benchmark
 * (CC-P8.1), so enforcing it moves the number it measures.
 *
 * Pure classifiers here; the runTurn guard tracks two per-turn flags (mutated,
 * verified) by feeding each tool call through `classifyForVerification`, then
 * fires ONE bounded nudge at turn end when mutated && !verified. The model can
 * justify skipping (docs-only change, nothing to run) in its next reply.
 */

const VERIFY_COMMAND =
  /\b(npm (run )?(test|build|lint|typecheck)|pnpm (test|build|lint)|yarn (test|build|lint)|vitest|jest|tsc\b|node --test|pytest|cargo (test|build|check|clippy)|go (test|build|vet)|make (test|check|build)|ruff|mypy|eslint|tsx? .*\.test\.)/i;

export const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch']);

export type VerificationSignal = 'mutated' | 'verified' | 'none';

/**
 * Classify a single tool call's effect on the verification contract. A
 * `run_command` running a build/test/lint counts as VERIFIED; other mutating
 * tools (edits) and other shell commands count as MUTATED; everything else is
 * neutral. Pure.
 */
export function classifyForVerification(toolName: string, commandText?: string): VerificationSignal {
  if (toolName === 'run_command') {
    return VERIFY_COMMAND.test(commandText ?? '') ? 'verified' : 'mutated';
  }
  if (EDIT_TOOLS.has(toolName)) return 'mutated';
  return 'none';
}

/**
 * True iff a verification nudge is warranted at turn end. Applies to child
 * agents too — a worker that edits files should verify them, the same way its
 * final message is its deliverable. Pure.
 */
export function shouldNudgeVerification(input: {
  mutated: boolean;
  verified: boolean;
  alreadyNudged: boolean;
}): boolean {
  if (input.alreadyNudged) return false;
  return input.mutated && !input.verified;
}

/** The corrective nudge injected at turn end. Pure. */
export function buildVerificationNudge(): string {
  return [
    'Runtime verification guardrail tripped.',
    'You changed the workspace this turn (file edits / writes) but ran no verification — no build, test, typecheck, or lint.',
    'Before claiming the work is done, prove it: run the relevant check (`run_command` with the project\'s test/build/typecheck/lint) and report the result.',
    'If there is genuinely nothing to run (a docs-only or config-only change), say so explicitly in your final answer instead of just asserting it works.',
  ].join('\n');
}

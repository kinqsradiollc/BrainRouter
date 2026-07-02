/**
 * AUTO-EXTRACTED from cli/repl.ts as part of the slash-command split.
 * Hand-tune imports if the compiler complains.
 *
 * Re-export barrel. The workflow / plan / goal / review / loop slash-command
 * handlers were broken out of this god file into cohesive sibling modules:
 *   - workflowHandlers.ts  — the `tryHandleWorkflowCommand` dispatch switch
 *   - workflowGrillGuard.ts — the `/grill-me` spec-exists guard
 *   - workflowSkills.ts     — the MCP skill-list normalizer
 *   - workflowHelpers.ts    — shared free helpers (force flag, banner, capture)
 * The public surface (these three symbols) is unchanged, so importers keep
 * using `./commands/workflow.js`.
 */

export { shouldSkipGrillMe } from './workflowGrillGuard.js';
export { tryHandleWorkflowCommand } from './workflowHandlers.js';
export { normalizeSkillsList } from './workflowSkills.js';

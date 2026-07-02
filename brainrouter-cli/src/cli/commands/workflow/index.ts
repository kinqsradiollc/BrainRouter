/**
 * Workflow slash-command entry point.
 *
 * This was originally a ~1400-line god file. It has been split into cohesive
 * sibling modules (handlers / grillGuard / skills / helpers) with the public
 * surface preserved: `tryHandleWorkflowCommand`, `shouldSkipGrillMe`, and
 * `normalizeSkillsList` are all still importable from this path.
 */

export { tryHandleWorkflowCommand } from './handlers.js';
export { shouldSkipGrillMe } from './grillGuard.js';
export { normalizeSkillsList } from './skills.js';

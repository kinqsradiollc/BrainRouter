/**
 * Compatibility facade for worktree isolation.
 *
 * Public imports remain unchanged while the implementation is decomposed behind
 * the isolation concern entrypoint. This move does not change runtime behavior.
 */
export * from './isolation/index.js';

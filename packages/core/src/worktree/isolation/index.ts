/**
 * Worktree-isolation concern entrypoint.
 *
 * Keeps the implementation internal to the concern folder while preserving the
 * complete legacy export surface through worktreeIsolation.ts.
 */
export * from './contracts.js';
export * from './presentation.js';
export * from './worktreeIsolation.impl.js';

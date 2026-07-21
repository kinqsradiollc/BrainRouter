/**
 * Filesystem persistence utilities for BrainRouter core (0.4.17).
 *
 * This barrel keeps the supported atomic-write surface in one place. It owns no
 * state or behavior and only re-exports the sibling implementation.
 */
export * from './atomicFile.js';

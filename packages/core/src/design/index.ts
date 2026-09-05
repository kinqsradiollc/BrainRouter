/**
 * Design — the deterministic half of design quality (ADR-056 Track B).
 *
 * A rule catalogue, a static engine over HTML/CSS/JSX, `design.md` tokens made
 * normative, and workspace suppressions. Findings share the review finding
 * vocabulary so they render on the same cards. Consumers import
 * `@kinqs/brainrouter-core/design`; the file layout stays internal.
 */
export * from './detect/index.js';
export { designHookBlock, designHookAfterWrite, designHookAtTurnEnd, isDesignHookTarget, DESIGN_HOOK_LIMITS, type DesignHookTier, type DesignHookAgent } from './hook.js';
export * from './vocabulary.js';
export * from './critique.js';
export * from './fidelity/index.js';

// Barrel for the agent `support` concern: smaller runtime helpers — interactive
// prompter, tool-result summaries, child-agent observation, and effort routing.
// Sub-structure only — no behavior change; modules keep their public surface.
export * from './childObservation.js';
export * from './effortRouting.js';
export * from './prompter.js';
export * from './toolSummary.js';

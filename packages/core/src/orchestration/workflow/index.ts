// Barrel for the `workflow` concern of orchestration: the declarative phase
// plan schema, the deterministic multi-phase executor, the build-loop merge
// gate + cross-worktree synthesis, and parent synthesis roll-up.
export * from './phasePlan.js';
export * from './phaseOrchestrator.js';
export * from './buildLoop.js';
export * from './mergeGate.js';
export * from './synthesis.js';

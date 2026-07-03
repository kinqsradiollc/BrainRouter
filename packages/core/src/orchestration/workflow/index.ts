// Barrel for the `workflow` concern — declarative PhasePlan parsing
// (`phasePlan`), phase execution (`phaseOrchestrator`), child-output synthesis
// (`synthesis`), and the build-run merge gate (`mergeGate`, `buildLoop`).
export * from './phasePlan.js';
export * from './phaseOrchestrator.js';
export * from './synthesis.js';
export * from './mergeGate.js';
export * from './buildLoop.js';

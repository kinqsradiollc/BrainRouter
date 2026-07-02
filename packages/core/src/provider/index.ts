// Public entrypoint for the `provider` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/provider` instead of deep `dist/provider/*.js` paths
// (including the nested providers/ and models/ dirs), so the subsystem's file
// layout stays an internal detail. Re-exports the modules the CLI and Desktop
// heads consume.
export * from './catalog.js';
export * from './tierLadder.js';
export * from './agentModels.js';
export * from './modelFamily.js';
export * from './providers/index.js';
export * from './providers/lmstudio/index.js';
export * from './models/reasoning.js';

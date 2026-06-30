// Public entrypoint for the `tool` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/tool` instead of deep `dist/tool/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './executors.js';
export * from './extractResult.js';
export * from './names.js';
export * from './registry.js';
export * from './specs.js';
export * from './toolBudget.js';

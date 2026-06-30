// Public entrypoint for the `background` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/background` instead of deep `dist/background/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './backgroundReconcile.js';
export * from './backgroundTaskStore.js';
export * from './backgroundTasks.js';

// Public entrypoint for the `task` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/task` instead of deep `dist/task/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './planHistoryStore.js';
export * from './taskStore.js';

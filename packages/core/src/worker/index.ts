// Public entrypoint for the `worker` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/worker` instead of deep `dist/worker/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './workerStore.js';

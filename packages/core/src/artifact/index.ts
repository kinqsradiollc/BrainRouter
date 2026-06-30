// Public entrypoint for the `artifact` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/artifact` instead of deep `dist/artifact/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './artifactStore.js';

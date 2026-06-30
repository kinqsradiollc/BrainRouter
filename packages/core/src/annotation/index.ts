// Public entrypoint for the `annotation` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/annotation` instead of deep `dist/annotation/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './annotationExport.js';
export * from './annotationStore.js';

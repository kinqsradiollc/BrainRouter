// Public entrypoint for the `context` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/context` instead of deep `dist/context/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './contextRegions.js';
export * from './contextEnvelope.js';
export * from './contextWindow.js';

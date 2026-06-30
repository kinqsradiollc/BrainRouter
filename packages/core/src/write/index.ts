// Public entrypoint for the `write` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/write` instead of deep `dist/write/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './grounding.js';
export * from './writeDiff.js';

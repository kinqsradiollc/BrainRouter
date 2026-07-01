// Public entrypoint for the `requirement` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/requirement` instead of deep `dist/requirement/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './delegationPacket.js';
export * from './planTrackSync.js';
export * from './pmFrameworks.js';
export * from './requirementDetector.js';
export * from './requirementStore.js';
export * from './trace.js';
export * from './traceStore.js';

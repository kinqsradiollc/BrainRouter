// Public entrypoint for the `requirement` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/requirement` instead of deep `dist/requirement/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './delegation/delegationPacket.js';
export * from './sync/planTrackSync.js';
export * from './frameworks/pmFrameworks.js';
export * from './records/requirementDetector.js';
export * from './records/requirementStore.js';
export * from './trace/trace.js';
export * from './trace/traceStore.js';

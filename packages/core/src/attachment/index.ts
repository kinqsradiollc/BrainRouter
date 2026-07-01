// Public entrypoint for the `attachment` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/attachment` instead of deep `dist/attachment/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './attachmentStore.js';
export * from './detect.js';
export * from './imageMeta.js';
export * from './ingest.js';
export * from './pdfText.js';

// Public entrypoint for the `attachment` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/attachment` instead of deep `dist/attachment/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './store/attachmentStore.js';
export * from './format/detect.js';
export * from './format/imageMeta.js';
export * from './ingest/ingest.js';
export * from './format/pdfText.js';
export * from './document/index.js';

// Public entrypoint for the `prompt` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/prompt` instead of deep `dist/prompt/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './planning/index.js';
export * from './compaction/index.js';
export * from './systemPrompt.js';
export * from './steering/index.js';

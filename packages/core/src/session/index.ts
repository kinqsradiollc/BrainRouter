// Public entrypoint for the `session` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/session` instead of deep `dist/session/*.js` paths, so
// the subsystem's file layout stays an internal detail. Re-exports the modules
// the CLI and Desktop heads actually consume; add to this list when a new
// session module becomes part of the public surface.
export * from './sessionStore.js';
export * from './sessionMetaStore.js';
export * from './sessionRuntimeStore.js';
export * from './sessionModeStore.js';
export * from './preferencesStore.js';
export * from './sessionRecap.js';
export * from './transcriptExport.js';
export * from './transcriptSearch.js';
export * from './chapterMarks.js';
export * from './completionInbox.js';
export * from './permissionModes.js';

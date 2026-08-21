// Public entrypoint for the `session` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/session` instead of deep `dist/session/*.js` paths, so
// the subsystem's file layout stays an internal detail. Re-exports the modules
// the CLI and Desktop heads actually consume; add to this list when a new
// session module becomes part of the public surface.
export * from './transcript/sessionStore.js';
export * from './state/sessionMetaStore.js';
export * from './state/sessionRuntimeStore.js';
export * from './state/sessionModeStore.js';
export * from './state/childConversationStore.js';
export * from './preferences/preferencesStore.js';
export * from './preferences/personality.js';
export * from './transcript/sessionRecap.js';
export * from './transcript/transcriptExport.js';
export * from './transcript/transcriptSearch.js';
export * from './transcript/chapterMarks.js';
export * from './completion/completionInbox.js';
export * from './feedback/messageFeedback.js';
export * from './preferences/permissionModes.js';
export * from './input/inputDelivery.js';
export * from './input/heldSessionMessages.js';
export * from './messaging/index.js';
export * from './sessionTitle.js';
export * from './trace/trajectoryStore.js';

// Public entrypoint for the `git` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/git` instead of deep `dist/git/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './checkpoint.js';
export * from './checkpointStore.js';
export * from './gitChurn.js';
export * from './prEmit.js';
export * from './workspaceGit.js';

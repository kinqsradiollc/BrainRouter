// Public entrypoint for the `track` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/track` instead of deep `dist/track/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './git/index.js';
export * from './github/index.js';
export * from './githubSync.js';
export * from './query/index.js';
export * from './automation/index.js';
export * from './trackStore.js';

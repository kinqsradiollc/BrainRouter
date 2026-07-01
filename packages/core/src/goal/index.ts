// Public entrypoint for the `goal` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/goal` instead of deep `dist/goal/*.js` paths, so the
// subsystem's file layout stays an internal detail.
export * from './goalStore.js';
export * from './goalKickoff.js';

// Public entrypoint for the `workspace` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/workspace` instead of deep `dist/workspace/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './workspace.js';
export * from './workspaceTrust.js';
export * from './manifest.js';

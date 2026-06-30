// Public entrypoint for the `worktree` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/worktree` instead of deep `dist/worktree/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './worktreeIsolation.js';

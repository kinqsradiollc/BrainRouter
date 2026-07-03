// Public entrypoint for the `workflow` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/workflow` instead of deep `dist/workflow/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported. Files are grouped into
// per-concern subfolders (graph/ run/ template/); this barrel re-exports them.
export * from './graph/index.js';
export * from './run/index.js';
export * from './template/index.js';

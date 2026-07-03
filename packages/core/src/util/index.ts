// Public entrypoint for the `util` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/util` instead of deep `dist/util/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported. Flat helpers are now
// grouped into per-concern subfolders (each with its own index.ts barrel);
// this facade re-exports them so the public surface is unchanged.
export * from './indexing/index.js';
export * from './tokens/index.js';
export * from './agentloop/index.js';
export * from './concurrency/index.js';
export * from './result/index.js';

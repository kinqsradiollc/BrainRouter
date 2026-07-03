// Public entrypoint for the `connectors` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/connectors` instead of deep `dist/connectors/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
//
// Sub-structure (per-concern, following the provider/ exemplar):
//   sources/ — the per-source connector runtimes (github, gitlab, google, web,
//              mcp, filesystem, and the api-source group)
//   stores/  — JSON-backed persistence (connector records, documents, permissions)
//   top-level facades — catalog, run-checkpoint dispatcher, memory/slim/definition bridges.
export * from './catalog.js';
export * from './sources/index.js';
export * from './stores/index.js';
export * from './definitionTransfer.js';
export * from './memoryBridge.js';
export * from './runCheckpoint.js';
export * from './slimRetrieval.js';

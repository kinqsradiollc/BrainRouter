// Public entrypoint for the `connectors` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/connectors` instead of deep `dist/connectors/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './catalog.js';
export * from './connectorStore.js';
export * from './definitionTransfer.js';
export * from './documentStore.js';
export * from './filesystemConnector.js';
export * from './githubConnector.js';
export * from './gitlabConnector.js';
export * from './memoryBridge.js';
export * from './permissionStore.js';
export * from './slimRetrieval.js';
export * from './webConnector.js';

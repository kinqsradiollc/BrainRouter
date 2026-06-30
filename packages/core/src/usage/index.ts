// Public entrypoint for the `usage` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/usage` instead of deep `dist/usage/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './usageHistoryStore.js';

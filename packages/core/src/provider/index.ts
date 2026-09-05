// Public entrypoint for the `provider` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/provider` instead of deep `dist/provider/*.js` paths
// (including the nested providers/ and models/ dirs), so the subsystem's file
// layout stays an internal detail. Re-exports the modules the CLI and Desktop
// heads consume.
export * from './catalog.js';
export * from './tierLadder.js';
export * from './agentModels.js';
export * from './llmProfiles.js';
export * from './modelFamily.js';
export * from './modelFallback.js';
export * from './modelPolicy.js';
export * from './budget.js';
export * from './gateway.js';
export * from './routing/index.js';
export * from './routing/gateway.js';
export * from './providers/index.js';
export * from './providers/lmstudio/index.js';
// ADR-047 D1 — declarative providers (loaded at boot by the CLI chat command).
export {
  registerDeclarativeProviders,
  declarativeToDefinition,
  _resetDeclarativeProvidersForTests,
  type DeclarativeRegistration,
} from './providers/declarative.js';
export { STARTER_DECLARATIVE_PROVIDERS } from './providers/declarative-starter.js';
// ADR-045 M4 — the client honors a gateway-advertised context_window cap.
export {
  extractAdvertisedContext,
  setManagedModelContext,
  lookupManagedModelContext,
  clearManagedModelContextForTests,
  type AdvertisedModelContext,
} from './managedModelContext.js';
export * from './models/reasoning.js';

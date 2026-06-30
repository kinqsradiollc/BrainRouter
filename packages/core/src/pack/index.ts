// Public entrypoint for the `pack` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/pack` instead of deep `dist/pack/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './packStore.js';
export * from './packs.js';

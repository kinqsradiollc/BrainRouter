// Public entrypoint for the `hooks` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/hooks` instead of deep `dist/hooks/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './hookifyStore.js';
export * from './hooksStore.js';

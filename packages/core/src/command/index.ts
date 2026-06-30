// Public entrypoint for the `command` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/command` instead of deep `dist/command/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './catalog.js';
export * from './parity.js';
export * from './registry.js';

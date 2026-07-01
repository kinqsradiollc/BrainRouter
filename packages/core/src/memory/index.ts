// Public entrypoint for the `memory` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/memory` instead of deep `dist/memory/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './anchorPin.js';
export * from './briefing.js';
export * from './briefingTriggers.js';
export * from './memoryEvents.js';
export * from './memoryPolicy.js';

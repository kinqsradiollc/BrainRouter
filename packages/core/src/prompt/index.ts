// Public entrypoint for the `prompt` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/prompt` instead of deep `dist/prompt/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './breadthHint.js';
export * from './compactor.js';
export * from './nextAction.js';
export * from './systemPrompt.js';
export * from './toolCompaction.js';
export * from './verbositySteering.js';

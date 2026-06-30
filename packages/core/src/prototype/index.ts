// Public entrypoint for the `prototype` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/prototype` instead of deep `dist/prototype/*.js` paths,
// keeping the subsystem's file layout internal. Full public surface; the
// internal service layer (service.ts) stays unexported.
export * from './placeholderRender.js';
export * from './protoDetect.js';
export * from './prototypePrompt.js';

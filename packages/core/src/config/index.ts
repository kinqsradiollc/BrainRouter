// Public entrypoint for the `config` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/config` instead of deep `dist/config/*.js` paths, so
// the subsystem's file layout stays an internal detail.
export * from './config.js';
export * from './configLoader.js';
export * from './configSchema.js';
export * from './permissionRules.js';
export * from './service.js';

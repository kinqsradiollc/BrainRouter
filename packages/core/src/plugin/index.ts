// Public entrypoint for the `plugin` subsystem (PLUGIN-MARKETPLACE P1).
// Consumers import `@kinqs/brainrouter-core/plugin` instead of deep
// `dist/plugin/*.js` paths. A plugin is a thin packaging + distribution wrapper
// that FEEDS the existing subsystems (skills / agents / commands / hooks / mcp /
// connectors / workflows) — no parallel runtime.
export * from './manifest.js';
export * from './paths.js';
export * from './discovery.js';
export * from './loader.js';
export * from './install.js';
export * from './scaffold.js';
export * from './service.js';

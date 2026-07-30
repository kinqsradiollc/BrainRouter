// Public entrypoint for the `plugin` subsystem (PLUGIN-MARKETPLACE P1).
// Consumers import `@kinqs/brainrouter-core/plugin` instead of deep
// `dist/plugin/*.js` paths. A plugin is a thin packaging + distribution wrapper
// that FEEDS the existing subsystems (skills / agents / orchestration profiles /
// commands / hooks / mcp / connectors / workflows) — no parallel runtime.
export * from './manifest.js';
export * from './paths.js';
export * from './discovery.js';
export * from './loader.js';
export * from './orgConvention.js';
export * from './install.js';
export * from './scaffold.js';
export * from './service.js';
export * from './marketplace.js';
export * from './integrity.js';
export * from './registry.js';
export * from './trust.js';
// PLUGIN-MARKETPLACE P5 — publish + auto-update + per-plugin project config.
export * from './installed.js';
export * from './publish.js';
export * from './update.js';
export * from './autoUpdate.js';
export * from './localConfig.js';

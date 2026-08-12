// Public entrypoint for the `mcp` subsystem (Refactor P1). Consumers import
// `@kinqs/brainrouter-core/mcp` instead of deep `dist/mcp/*.js` paths, so the
// subsystem's file layout stays an internal detail. Re-exports the modules the
// CLI and Desktop heads consume; discovery/reconnect remain internal wiring.
export * from './mcpUtils.js';
export * from './mcpClient.js';
export * from './mcpPool.js';
export * from './hostLearning.js';
export * from './sessionMessages.js';

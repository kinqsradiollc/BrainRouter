/**
 * Barrel — the single-server MCP client wrapper.
 *
 * The implementation was split into focused siblings (Refactor: mcp god-file
 * breakdown); this file stays a thin re-export so existing deep imports of
 * `mcp/mcpClient.js` keep resolving the same public symbols:
 *   - {@link McpClientWrapper}          → ./client.js
 *   - {@link resolveIdentityFromConfig} → ./identity.js
 *   - {@link isSessionNotFoundError}    → ./sessionErrors.js
 */
export { McpClientWrapper } from './client/client.js';
export { resolveIdentityFromConfig } from './client/identity.js';
export { isSessionNotFoundError } from './client/sessionErrors.js';
export type { HostLearningRequest, HostLearningResult } from './hostLearning.js';

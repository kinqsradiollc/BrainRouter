// Barrel — the single-server MCP client wrapper and its connect-path helpers.
// Groups the wrapper implementation (client.ts) with the focused siblings the
// connect path splits into: identity resolution, session-expiry matching, and
// transport construction. The top-level `mcpClient.ts` facade re-exports the
// public subset consumers deep-import.
export { McpClientWrapper } from './client.js';
export { resolveIdentityFromConfig } from './identity.js';
export { isSessionNotFoundError } from './sessionErrors.js';
export { buildHttpTransport, buildStdioTransport } from './transport.js';

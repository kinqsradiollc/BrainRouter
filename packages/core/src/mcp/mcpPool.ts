/**
 * Barrel — the multi-server MCP client pool + its brain-profile / tool-name /
 * reconnect helpers.
 *
 * The implementation was split into focused siblings (Refactor: mcp god-file
 * breakdown); this file stays a thin re-export so existing deep imports of
 * `mcp/mcpPool.js` keep resolving the same public symbols:
 *   - {@link McpClientPool}                                  → ./pool/pool.js
 *   - selectMcpServerIds / applyBrainUrlOverride /
 *     brainHealthUrl / probeBrainHealth / embeddedBrainId    → ./pool/brainProfiles.js
 *   - {@link normalizeMcpToolName}                           → ./pool/toolNames.js
 *   - {@link dueForReconnect}                                → ./pool/reconnectSweep.js
 *   - McpServerStatus / BrainHealth (types)                  → ./types.js
 */
export type { McpServerStatus, BrainHealth } from './types.js';
export { McpClientPool } from './pool/pool.js';
export {
  selectMcpServerIds,
  applyBrainUrlOverride,
  brainHealthUrl,
  probeBrainHealth,
  embeddedBrainId,
} from './pool/brainProfiles.js';
export { normalizeMcpToolName } from './pool/toolNames.js';
export { dueForReconnect } from './pool/reconnectSweep.js';
export type { HostLearningRequest, HostLearningResult } from './hostLearning.js';

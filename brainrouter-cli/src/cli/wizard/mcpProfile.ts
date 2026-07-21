/**
 * BrainRouter MCP profile-name allocation for CLI setup (0.4.17).
 *
 * Converts a transport choice into a stable configured id so repeat setup edits
 * the same BrainRouter entry without overwriting an unrelated MCP server. An
 * occupied name is reusable only when its config proves ownership, and fallback
 * allocation is bounded by the current server catalog.
 */
import type { ServerConfig } from '@kinqs/brainrouter-core/config';
import { resolveIdentityFromConfig } from '@kinqs/brainrouter-core/mcp';
import type { McpPick } from './types.js';

function preferredProfileName(pick: Exclude<McpPick, { kind: 'skip' }>): string {
  if (pick.kind === 'remote-http') return 'remote';
  if (pick.kind === 'local-http') return 'local-http';
  return 'local-stdio';
}

/**
 * Pick a stable BrainRouter profile id without overwriting an unrelated MCP.
 * Existing BrainRouter-owned entries are intentionally reusable so rerunning
 * global setup edits the same profile rather than accumulating duplicates.
 */
export function resolveWizardMcpProfileName(
  servers: Record<string, ServerConfig>,
  pick: Exclude<McpPick, { kind: 'skip' }>,
): string {
  const preferred = preferredProfileName(pick);
  const candidates = [preferred, `brainrouter-${preferred}`];
  for (const candidate of candidates) {
    const existing = servers[candidate];
    // Do not pass `candidate` into identity detection here: names beginning
    // with "brainrouter" are normally a useful hint, but an unrelated user
    // may already own that exact profile id. Only the config itself can prove
    // that an occupied slot belongs to BrainRouter.
    if (!existing || resolveIdentityFromConfig(existing) === 'brainrouter') return candidate;
  }

  // At most `server count + 1` numbered candidates can be occupied, so this
  // bounded loop always finds a free id without trusting unbounded user input.
  for (let suffix = 2; suffix <= Object.keys(servers).length + 2; suffix += 1) {
    const candidate = `brainrouter-${preferred}-${suffix}`;
    const existing = servers[candidate];
    if (!existing || resolveIdentityFromConfig(existing) === 'brainrouter') return candidate;
  }
  throw new Error('Could not allocate a BrainRouter MCP profile name.');
}

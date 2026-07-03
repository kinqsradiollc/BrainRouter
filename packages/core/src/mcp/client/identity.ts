import type { ServerConfig } from '../../config/config.js';
import type { McpIdentity } from '../types.js';

/**
 * 10a: figure out who an MCP profile belongs to from config metadata + name
 * + URL alone, before any network call. Explicit `identity` wins; otherwise
 * we check name prefix and URL host. Returns 'unknown' when nothing matches
 * — the caller (currently `listTools`) falls back to tool-signature
 * detection after the first successful enumeration.
 *
 * Detection cases:
 *   - explicit `identity: 'brainrouter'` or `identity: 'third-party'` → that.
 *   - profile name (case-insensitive) starts with `brainrouter` → brainrouter.
 *   - http URL hostname matches `*.brainrouter.cloud` / `*.brainrouter.dev`
 *     / `*.brainrouter.io` / `*.kinqs.brainrouter.*` → brainrouter.
 *   - stdio command basename matches `brainrouter` / `brainrouter-mcp` → brainrouter.
 *   - otherwise → unknown (let the tool-signature fallback decide).
 */
export function resolveIdentityFromConfig(
  serverConfig: ServerConfig,
  name?: string,
): McpIdentity {
  if (serverConfig.identity === 'brainrouter' || serverConfig.identity === 'third-party') {
    return serverConfig.identity;
  }
  if (name && /^brainrouter/i.test(name.trim())) {
    return 'brainrouter';
  }
  if (serverConfig.type === 'http' && serverConfig.url) {
    try {
      const url = new URL(serverConfig.url);
      if (/\.brainrouter\.(cloud|dev|io|com|app)$/i.test(url.hostname)) {
        return 'brainrouter';
      }
    } catch {
      // Malformed URL; let later code surface the connection error.
    }
  }
  if (serverConfig.type === 'stdio' && serverConfig.command) {
    const base = serverConfig.command.split(/[/\\]/).pop() ?? '';
    if (/^brainrouter(-mcp)?$/i.test(base)) {
      return 'brainrouter';
    }
  }
  return 'unknown';
}

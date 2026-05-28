/**
 * Per-vendor MCP install snippets (0.3.8-I5 / roadmap §9).
 *
 * Pattern adapted from semble's per-agent install docs
 * (openSrc/semble/src/semble/agents/*.md) — one focused entry per vendor
 * with the exact JSON shape and config file path. Where semble ships
 * markdown, we ship structured templates so the CLI can substitute the
 * user's live profile URL + API key on the fly.
 *
 * Notes
 * - Tool name examples use the single-underscore convention
 *   `mcp_<server>_<tool>` (0.3.8-R5 decision).
 * - Each template is pinned to a "verified against vendor docs as of …"
 *   comment. Vendor MCP schemas drift; bump the date when you re-verify.
 * - We never auto-write the vendor config file. Print only — direct-write
 *   is a future enhancement (roadmap: future item; do not file a follow-up).
 */

import os from 'node:os';
import path from 'node:path';

export type VendorSchema = 'stdio' | 'http' | 'sse';

export interface VendorVars {
  /** Active BrainRouter profile URL (http transport). */
  url: string;
  /** Active BrainRouter profile API key — rendered verbatim into the snippet. */
  apiKey: string;
  /** Server id the user picks in their vendor config (defaults to "brainrouter"). */
  serverId?: string;
}

export interface VendorEntry {
  id: string;
  label: string;
  schema: VendorSchema;
  /** Restart note shown after the snippet. */
  restart: string;
  /** Per-OS config file path. POSIX path with `~` for the user's home. */
  configPath: (platform: NodeJS.Platform) => string;
  /** Pure template — returns the JSON object the user should merge into their vendor config. */
  template: (vars: VendorVars) => unknown;
  /** Free-form note (e.g. nested-key location, alternative shape). */
  note?: string;
}

// Helpers ------------------------------------------------------------------

function home(platform: NodeJS.Platform): string {
  // Tests can override HOME / APPDATA; in production this is os.homedir().
  if (platform === 'win32') return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return os.homedir();
}

/** Render a config path for human display — backslashes on Windows. */
export function displayPath(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.replace(/\//g, '\\') : p;
}

// Vendor definitions -------------------------------------------------------

export const VENDORS: Record<string, VendorEntry> = {
  'claude-desktop': {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    schema: 'http',
    restart: 'Quit and reopen Claude Desktop fully — it only re-reads this file on cold start.',
    // Verified against Anthropic docs as of 2026-05.
    configPath: (p) =>
      p === 'win32'
        ? path.join(home(p), 'Claude', 'claude_desktop_config.json')
        : p === 'darwin'
          ? path.join(home(p), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
          : path.join(home(p), '.config', 'Claude', 'claude_desktop_config.json'),
    template: ({ url, apiKey, serverId = 'brainrouter' }) => ({
      mcpServers: {
        [serverId]: {
          url,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    }),
  },

  cursor: {
    id: 'cursor',
    label: 'Cursor',
    schema: 'http',
    restart: 'Cursor reloads MCP servers automatically; reopen the MCP panel if the server does not appear.',
    // Verified against Cursor docs as of 2026-05 (~/.cursor/mcp.json).
    configPath: (p) => path.join(home(p), '.cursor', 'mcp.json'),
    template: ({ url, apiKey, serverId = 'brainrouter' }) => ({
      mcpServers: {
        [serverId]: {
          url,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    }),
  },

  windsurf: {
    id: 'windsurf',
    label: 'Windsurf (Codeium)',
    schema: 'http',
    restart: 'Open the Windsurf MCP panel and click "Refresh" — no full restart needed.',
    // Verified against Codeium docs as of 2026-05 (~/.codeium/windsurf/mcp_config.json).
    configPath: (p) => path.join(home(p), '.codeium', 'windsurf', 'mcp_config.json'),
    template: ({ url, apiKey, serverId = 'brainrouter' }) => ({
      mcpServers: {
        [serverId]: {
          serverUrl: url,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    }),
  },

  'vscode-continue': {
    id: 'vscode-continue',
    label: 'VS Code (Continue extension)',
    schema: 'http',
    restart: 'Continue picks up config.json changes live — no reload required.',
    // Verified against Continue docs as of 2026-05. MCP servers live under
    // experimental.modelContextProtocolServers in ~/.continue/config.json.
    configPath: (p) => path.join(home(p), '.continue', 'config.json'),
    note: 'Merge this block into the top-level object — Continue keys MCP servers under `experimental.modelContextProtocolServers`.',
    template: ({ url, apiKey, serverId = 'brainrouter' }) => ({
      experimental: {
        modelContextProtocolServers: [
          {
            name: serverId,
            transport: { type: 'http', url, headers: { Authorization: `Bearer ${apiKey}` } },
          },
        ],
      },
    }),
  },

  zed: {
    id: 'zed',
    label: 'Zed',
    schema: 'http',
    restart: 'Zed reloads settings.json on save; reopen the assistant panel to see the new server.',
    // Verified against Zed docs as of 2026-05. MCP servers live under
    // `context_servers` in settings.json.
    configPath: (p) => path.join(home(p), '.config', 'zed', 'settings.json'),
    note: 'Merge the `context_servers` key into your existing settings.json.',
    template: ({ url, apiKey, serverId = 'brainrouter' }) => ({
      context_servers: {
        [serverId]: {
          source: 'custom',
          url,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    }),
  },

  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code (CLI)',
    schema: 'http',
    restart: 'Claude Code re-reads `~/.claude/mcp.json` on next session start — start a fresh `claude` session to pick up the server.',
    // Verified against Claude Code docs as of 2026-05.
    configPath: (p) => path.join(home(p), '.claude', 'mcp.json'),
    note: 'Federation: every Claude Code session sharing your BrainRouter API key joins the same shared-memory pool (0.4.0 Stage 1).',
    template: ({ url, apiKey, serverId = 'brainrouter' }) => ({
      mcpServers: {
        [serverId]: {
          url,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    }),
  },

  codex: {
    id: 'codex',
    label: 'Codex (CLI)',
    schema: 'http',
    restart: 'Codex re-reads `~/.codex/mcp.json` on next session start — start a fresh `codex` session to pick up the server.',
    // Verified against Codex CLI docs as of 2026-05.
    configPath: (p) => path.join(home(p), '.codex', 'mcp.json'),
    note: 'Federation: paired with a BrainRouter CLI on the same userId, Codex reads + writes the shared memory pool over the same HTTP MCP transport (0.4.0 Stage 1).',
    template: ({ url, apiKey, serverId = 'brainrouter' }) => ({
      mcpServers: {
        [serverId]: {
          url,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    }),
  },

  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    schema: 'http',
    restart: 'Gemini CLI reloads MCP config on next invocation — no daemon to restart.',
    // Verified against Gemini CLI docs as of 2026-05.
    configPath: (p) => path.join(home(p), '.gemini', 'mcp.json'),
    note: 'Federation: same shared-memory pool as BrainRouter CLI / Claude Code / Codex when a single BrainRouter userId is used (0.4.0 Stage 1).',
    template: ({ url, apiKey, serverId = 'brainrouter' }) => ({
      mcpServers: {
        [serverId]: {
          url,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    }),
  },

  cline: {
    id: 'cline',
    label: 'Cline (VS Code)',
    schema: 'http',
    restart: 'Cline reloads MCP servers when this file is saved — toggle the server off/on in the MCP panel if not.',
    // Verified against Cline docs as of 2026-05.
    configPath: (p) =>
      p === 'darwin'
        ? path.join(home(p), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
        : p === 'win32'
          ? path.join(home(p), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
          : path.join(home(p), '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    template: ({ url, apiKey, serverId = 'brainrouter' }) => ({
      mcpServers: {
        [serverId]: {
          url,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    }),
  },
};

export function listVendors(): VendorEntry[] {
  return Object.values(VENDORS);
}

export function getVendor(id: string): VendorEntry | undefined {
  return VENDORS[id.toLowerCase()];
}

export function renderSnippet(entry: VendorEntry, vars: VendorVars): string {
  return JSON.stringify(entry.template(vars), null, 2);
}

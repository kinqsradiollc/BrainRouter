# Installing BrainRouter MCP in Non-CLI Hosts

BrainRouter exposes an HTTP MCP server you can plug into any host that
speaks the Model Context Protocol — Claude Desktop, Cursor, Windsurf,
VS Code (Continue), Zed, Cline, and more.

The fastest path is the in-CLI snippet generator:

```
/mcp install list             # list supported vendors
/mcp install <vendor>         # paste-ready JSON for one vendor
```

`/mcp install <vendor>` substitutes the URL + API key from your active
BrainRouter profile, prints the exact config file path for your OS, and
includes a per-vendor restart note. Run `/login` first if you don't have
an active profile yet.

> ⚠ The generated block contains your **live API key**. Paste into your
> vendor config and do not commit it.

## Supported vendors

| id                | Host                          | Config path (POSIX)                                                              |
| ----------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| `claude-desktop`  | Claude Desktop                | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)        |
| `cursor`          | Cursor                        | `~/.cursor/mcp.json`                                                             |
| `windsurf`        | Windsurf (Codeium)            | `~/.codeium/windsurf/mcp_config.json`                                            |
| `vscode-continue` | VS Code (Continue extension)  | `~/.continue/config.json` (under `experimental.modelContextProtocolServers`)     |
| `zed`             | Zed                           | `~/.config/zed/settings.json` (under `context_servers`)                          |
| `cline`           | Cline (VS Code)               | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` (macOS) |

Per-vendor restart behaviour:

- **Claude Desktop** — full quit + reopen (only re-reads config on cold start).
- **Cursor** — auto-reloads; reopen the MCP panel if the server doesn't appear.
- **Windsurf** — click "Refresh" in the MCP panel.
- **VS Code Continue** — picks up changes live; no reload required.
- **Zed** — reloads on save; reopen the assistant panel.
- **Cline** — toggle the server off/on in the MCP panel if it doesn't auto-reload.

## Example: Cursor

`/mcp install cursor` prints something like:

```json
{
  "mcpServers": {
    "brainrouter": {
      "url": "https://api.brainrouter.cloud/mcp",
      "headers": { "Authorization": "Bearer br_live_..." }
    }
  }
}
```

Paste into `~/.cursor/mcp.json`, merging with any existing `mcpServers`.

## Conventions

- Tool calls reference servers as `mcp_<server>_<tool>` (single-underscore;
  see release notes for the 0.3.8-R5 naming decision).
- Templates are pinned to "verified against vendor docs as of 2026-05".
  If a vendor's schema changes, update `brainrouter-cli/src/runtime/vendorSnippets.ts`
  and re-date the pin.

## Direct-write (not yet)

We intentionally print the snippet rather than editing your vendor config
file directly. Auto-merging into JSON files that may contain user
comments / trailing commas / other servers is risky enough that we want
explicit consent; direct-write is tracked as a post-0.4.0 polish item.

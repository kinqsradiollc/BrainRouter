# Installing BrainRouter MCP in Non-CLI Hosts

BrainRouter exposes an HTTP MCP server you can plug into any host that
speaks the Model Context Protocol — Claude Desktop, Claude Code, Codex,
Cursor, Gemini CLI, Windsurf, VS Code (Continue), Zed, Cline, and more.

## Federation primer (0.4.0)

As of **0.4.0**, every MCP-aware host you connect to a BrainRouter
profile joins a **shared memory plane** keyed by your BrainRouter
userId (resolved from the API key in the snippet below). A spec
drafted in BrainRouter CLI this morning is visible to Claude Code or
Codex this afternoon without any handoff step. Two windows of the same
host pointed at the same key federate too — they see each other's
sessions and can pass messages once Stages 2–3 land.

Concretely:

- **Shared memory.** All cognitive records, working memory, and
  briefing sources resolve against the same SQLite pool when hosts
  share a userId. WAL mode is required (and verified by the brain
  store on boot — see §4.1 `FED-S1-T1`).
- **Per-host transport.** All federated hosts use the same HTTP MCP
  endpoint with `Authorization: Bearer <api-key>` — there's no
  per-vendor protocol surface to learn.
- **Workspace scoping (optional).** A future Stage 1 task wires a
  `workspaceTag` filter so an editing-project-A session doesn't see
  the noise from project-B (FED-S1-T3); ungated until then.

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
| `claude-code`     | Claude Code (CLI)             | `~/.claude/mcp.json`                                                             |
| `codex`           | Codex (CLI)                   | `~/.codex/mcp.json`                                                              |
| `cursor`          | Cursor                        | `~/.cursor/mcp.json`                                                             |
| `gemini-cli`      | Gemini CLI                    | `~/.gemini/mcp.json`                                                             |
| `windsurf`        | Windsurf (Codeium)            | `~/.codeium/windsurf/mcp_config.json`                                            |
| `vscode-continue` | VS Code (Continue extension)  | `~/.continue/config.json` (under `experimental.modelContextProtocolServers`)     |
| `zed`             | Zed                           | `~/.config/zed/settings.json` (under `context_servers`)                          |
| `cline`           | Cline (VS Code)               | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` (macOS) |

Per-vendor restart behaviour:

- **Claude Desktop** — full quit + reopen (only re-reads config on cold start).
- **Claude Code** — start a fresh `claude` session; `~/.claude/mcp.json` is re-read at session start.
- **Codex** — start a fresh `codex` session; `~/.codex/mcp.json` is re-read at session start.
- **Cursor** — auto-reloads; reopen the MCP panel if the server doesn't appear.
- **Gemini CLI** — reloads on next invocation; no daemon to restart.
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

## Example: Claude Code

`/mcp install claude-code` prints:

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

Save to `~/.claude/mcp.json` (merge with any existing `mcpServers`),
then start a fresh `claude` session. The shared memory pool is
immediate — any record you wrote from BrainRouter CLI under the same
userId is recallable from Claude Code.

## Example: Codex

`/mcp install codex` prints the same shape, destined for
`~/.codex/mcp.json`. Restart pattern identical: start a fresh `codex`
session.

## Example: Gemini CLI

`/mcp install gemini-cli` prints the same shape, destined for
`~/.gemini/mcp.json`. No restart needed — the next `gemini` invocation
picks it up.

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

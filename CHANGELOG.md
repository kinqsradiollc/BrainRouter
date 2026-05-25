# Changelog

All notable BrainRouter changes. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and versions
follow [SemVer](https://semver.org/spec/v2.0.0.html).

Use this file for the **current release view**. Full per-version notes
live in [`brainrouter-changelog/`](brainrouter-changelog/).

---

## Current Release View

| Version | State | Full notes |
|---|---|---|
| **0.3.7** | Unreleased / in-flight | [`brainrouter-changelog/0.3.7.md`](brainrouter-changelog/0.3.7.md) |
| **0.3.6** | Shipped — 2026-05-25 | [`brainrouter-changelog/0.3.6.md`](brainrouter-changelog/0.3.6.md) |

Planning for future releases belongs in [`ROADMAP.md`](ROADMAP.md), not
this changelog. In particular, 0.3.8 is planned in
[`brainrouter-roadmap/0.3.8.md`](brainrouter-roadmap/0.3.8.md) and
should get a changelog entry only when implementation starts.

---

## [0.3.7] - Unreleased

**Theme:** terminal UI redesign, in-terminal configuration, full Ink
chat REPL, CLI/server environment separation, and multi-agent registry
foundations.

### Added

- First-run wizard inside the REPL:
  `Welcome -> Theme -> Provider -> API key -> Model -> MCP -> AGENT.md -> Done`.
- `/init` wizard re-entry point; `/init agentmd` preserves the old
  AGENT.md-only behavior.
- `/config` settings home panel plus scriptable
  `/config <key>` and `/config <key> <value>` forms.
- `/login` slash command for MCP profile editing inside the REPL.
- Full Ink chat REPL for banner, composer, scrollback, tool events,
  slash palette, footer, and progress/status rows.
- Inline slash command palette with fuzzy ranking and keyboard
  navigation.
- In-chat overlay slot for `/config`, `/login`, and `/init` picker
  flows.
- `/model` no-arg quick-swap picker backed by the active endpoint's
  `/v1/models` response.
- **Multi-MCP support.** The CLI now connects to every configured MCP
  server concurrently on boot (Claude Code style), instead of only the
  single `activeServer` profile. Tools across all servers are merged
  into one inventory with `mcp__<serverId>__<toolName>` prefixing for
  disambiguation; raw tool names route to the unique provider as a
  back-compat alias, with collision detection emitting a helpful
  prefix hint. New `/mcp connect <name>`, `/mcp disconnect <name>`,
  and `/mcp reconnect [name]` commands; `/mcp list` now shows
  per-server status and tool count; `/mcp tools [server]` filters by
  serverId. Offline servers degrade gracefully — one server failing
  does not cascade. New `McpClientPool` in
  [`runtime/mcpPool.ts`](brainrouter-cli/src/runtime/mcpPool.ts);
  facade matches the legacy `McpClientWrapper` API so existing
  call-sites are near-no-op type swaps.
- **`/config` MCP editor is now a multi-profile manager.** The MCP
  row in the `/config` panel previously opened a single transport
  picker that overwrote the one BrainRouter profile. Rebuilt as a
  profile MANAGER: the top-level panel lists every server in the
  config, plus "+ Add new MCP server" and "Set highlighted server"
  rows. Picking an existing server opens per-profile actions (edit
  URL/command, update API key, probe, remove). Adding a new server
  runs a 4-step flow (name → identity → transport → fields → API
  key) and auto-connects it to the running pool — no CLI restart
  required. Identity tag drives whether the key step uses the
  BrainRouter env-var pre-fill or a generic bearer-token prompt.

### Changed

- Ink chat REPL is now the default. The old readline turn loop was
  removed from runtime use.
- CLI credentials now come from `~/.config/brainrouter/config.json`.
  The CLI no longer reads `brainrouter-cli/.env` or `brainrouter/.env`
  for LLM credentials.
- MCP child stderr is piped so server logs do not render above the Ink
  UI.
- Wizard Skip now clears stale `activeServer` instead of silently
  reconnecting to an old MCP profile.
- Documentation now leads with the interactive wizard and in-REPL
  config flow.

### Fixed

- `/config provider <id>` prompts for the new provider's API key instead
  of silently reusing the previous provider's key.
- Config env fallback now covers all catalogued providers.
- `/login` can update LLM credentials after MCP profile setup.
- HTTP MCP setup now prompts for and stores the BrainRouter API key for
  both local and remote HTTP transports.
- Picker/overlay raw-mode conflicts that caused `/config` to hang inside
  chat were resolved by rendering overlays inside the single Ink tree.

### Tests

- Added broad test coverage for wizard reducers, config command parsing,
  Ink chat rendering, markdown rendering, tool formatting, slash
  suggestions, picker behavior, and model API helpers.
- Last recorded suite status in the detailed notes: BrainRouter 262/262
  and BrainRouter CLI 319/319 green; TypeScript clean.

---

## [0.3.6] - 2026-05-25

**Theme:** smarter recall, friendlier CLI, more reliable agent loop.

### Added

- Multi-workflow concurrency via `/workflow switch <slug>` and
  `/workflows`.
- Session knobs: `/effort`, `/mode`, `/review-policy`, `/grill-me`,
  and `ask_user_choice`.
- MCP identity detection, brain-offline UX, and multi-MCP dispatcher:
  `/mcp list`, `/mcp reconnect`, `/mcp tools`.

### Changed

- System prompt reduced by roughly 70%.
- Recall briefing gated to turn 1, post-compaction, or entity-rich
  prompts.
- Goal text deduplicated to a single per-turn anchor.

### Fixed

- REPL stdin no longer freezes after spinner-based slash commands.

---

## Older Releases

| Version | Date | Highlights |
|---|---|---|
| [0.3.5](brainrouter-changelog/0.3.5.md) | 2026-05-22 | Global-install UX fix: `brainrouter-mcp init`, env-loader priority chain |
| [0.3.4](brainrouter-changelog/0.3.4.md) | 2026-05-22 | First public npm release across four `@kinqs/` packages |
| [0.3.3](brainrouter-changelog/0.3.3.md) | 2026-05-21 | `/goal` state machine, token budget, wrap-up steering |
| [0.3.2](brainrouter-changelog/0.3.2.md) | 2026-05-19 | Observability, headless behavior, statusline polish |
| [0.3.1](brainrouter-changelog/0.3.1.md) | 2026-05-17 | Reliability hardening for memory, MCP, compaction, and state corruption |
| [0.3.0](brainrouter-changelog/0.3.0.md) | 2026-05-16 | Terminal Agent CLI, multi-agent orchestration, memory engine |
| [0.2.0](brainrouter-changelog/0.2.0.md) | 2026-05-15 | Admin console, Memories Hub, contradiction UI |

See [`brainrouter-changelog/README.md`](brainrouter-changelog/README.md)
for the full index and writing conventions.

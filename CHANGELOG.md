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
| **0.3.7** | Shipped — 2026-05-25 | [`brainrouter-changelog/0.3.7.md`](brainrouter-changelog/0.3.7.md) |
| **0.3.6** | Shipped — 2026-05-25 | [`brainrouter-changelog/0.3.6.md`](brainrouter-changelog/0.3.6.md) |

Planning for future releases belongs in [`ROADMAP.md`](ROADMAP.md), not
this changelog. In particular, 0.3.8 is planned in
[`brainrouter-roadmap/0.3.8.md`](brainrouter-roadmap/0.3.8.md) and
should get a changelog entry only when implementation starts.

---

## [0.3.7] - 2026-05-25

Terminal UI redesign, in-terminal configuration, full Ink chat REPL, and multi-agent registry foundations.

- **Full Ink chat REPL.** Every surface — banner, composer, scrollback, tool events, slash palette, footer — renders through a single Ink tree. Inline slash palette with fuzzy ranking and keyboard navigation; `/config` / `/login` / `/init` render as overlays inside the chat, eliminating raw-mode conflicts.
- **First-run wizard** auto-triggers on first launch: `Welcome → Theme → Provider → API key → Model → MCP → AGENT.md → Done`. Re-enterable via `/init`; `/init agentmd` for legacy AGENT.md-only scaffold.
- **`/config` settings panel + multi-profile MCP manager.** Arrow-key settings home; `/config <key>` / `/config <key> <value>` scriptable forms. MCP row rebuilt as a full profile manager (list, add, edit, probe, remove) with hot-connect — no CLI restart needed.
- **`/login`** in-REPL MCP profile editor; **`/model`** live model picker from the active endpoint's `/v1/models`.
- **Multi-MCP pool.** Connects to all configured servers concurrently on boot; tools merged into one inventory with `mcp__<serverId>__<tool>` prefixing. `/mcp connect|disconnect|reconnect` commands; one server failure does not cascade.
- **Identity-based MCP tool prefix.** Servers with `identity: "brainrouter"` expose tools as `mcp__brainrouter__<tool>` regardless of their config key — skills targeting the canonical prefix survive profile renames.
- **Data-driven agent registry.** Built-in agents (`explorer`, `architect`, `reviewer`, `worker`, `verifier`) are JSON files under `brainrouter-cli/agents/`. Three-tier merge: built-in → user-global → workspace, workspace wins. `spawn_agent` gains `agentId`; `/agents defs` lists all definitions.
- **Spawn tier hierarchy + depth caps.** `tier` field (`reasoning` | `worker`) on each definition; depth capped at 3 (`BRAINROUTER_MAX_SPAWN_DEPTH`). `worker` agents cannot delegate; `reasoning` agents can only spawn `worker` children.
- **CLI/server env separation.** CLI reads credentials only from `~/.config/brainrouter/config.json`; package `.env` files no longer read. MCP child stderr piped — server logs no longer bleed into the Ink UI.

---

## [0.3.6] - 2026-05-25

Smarter recall, friendlier CLI, more reliable agent loop.

- **Multi-workflow concurrency.** `/workflow switch <slug>` flips between workflows in the same workspace; `/workflows` lists them with artifact markers.
- **New session knobs.** `/effort low|medium|high`, `/mode planning|fast`, `/review-policy request|proceed`, `/grill-me <task>`, and `ask_user_choice` mid-turn arrow-key picker.
- **Context budget — 70% lighter system prompt + gated recall.** Static prompt cut from ~4,750 → ~1,400 tokens; briefing fires only on turn 1, post-compaction, or entity-rich prompts. Goal text deduplicated to a single per-turn anchor.
- **MCP identity + offline UX + multi-MCP foundation.** BrainRouter MCP auto-detected; offline swaps system prompt to a `⚠️ OFFLINE` block. New `/mcp list` / `/mcp reconnect` / `/mcp tools` dispatcher.
- **REPL stdin no longer freezes** after spinner-based slash commands.

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

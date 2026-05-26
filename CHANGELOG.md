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
| **0.3.9** | In progress | [`brainrouter-changelog/0.3.9.md`](brainrouter-changelog/0.3.9.md) |
| **0.3.8** | Shipped — 2026-05-26 | [`brainrouter-changelog/0.3.8.md`](brainrouter-changelog/0.3.8.md) |
| **0.3.7** | Shipped — 2026-05-26 | [`brainrouter-changelog/0.3.7.md`](brainrouter-changelog/0.3.7.md) |
| **0.3.6** | Shipped — 2026-05-25 | [`brainrouter-changelog/0.3.6.md`](brainrouter-changelog/0.3.6.md) |

Planning for future releases belongs in [`ROADMAP.md`](ROADMAP.md), not
this changelog.

---

## [0.3.9] - Unreleased

CLI memory briefing quality release before 0.4.0.

- **Adaptive briefing triggers.** Gated recall now reasons over first turn, post-compaction, continuation, memory/history, file path, debug/retry, recent tool failure, active-goal periodic refresh, and child-agent synthesis cues instead of only first-turn/post-compaction/entity-token checks.
- **Source-aware briefing.** Auto-briefing can route across recall, working memory, task state, recall explanations, file history, and failed attempts, while degrading cleanly when optional MCP tools are absent.
- **TokenJuice-lite compaction.** Large JSON and command/tool outputs are compacted before entering model-visible context; full raw outputs remain in transcripts.
- **Inspectable memory decisions.** `/briefing` now shows decision, reasons, planned/queried sources, skipped sources, source stats, record IDs, warnings, injected tokens, and compacted chars avoided.
- **Read-only source manifest spike.** `/memories sources [limit]` scans local code/docs into a bounded ephemeral manifest without schema writes, chunk tables, or vault mirroring.
- **Memory capture redaction + secret block.** CLI turn capture redacts obvious secrets and now refuses the capture outright when credential-shaped tokens (`sk-…`, `ghp_…`, `AKIA…`, PEM keys, Slack `xox`) remain in the payload. Recall card previews are redacted to match the opaque-dump path.
- **Memory policy warnings.** `/briefing` flags stale/superseded/needs-verification records and off-workspace path references in recalled content via a new `memoryPolicy` module.
- **Briefing benchmark coverage.** Local tests cover trigger cases, compaction savings, and end-to-end `buildMemoryBriefing` runs against stub MCP for all six roadmap scenarios (first-turn, continuation, file-specific, debug retry, post-compaction, child synthesis).

---

## [0.3.8] - 2026-05-26

CLI delegation reliability, parallel reads, native Anthropic adapter, and a tranche of quick wins carried from 0.3.7.

- **Runtime child-drain guardrail.** Parent turn refuses to accept a no-tool answer while spawned children are pending/running; auto-calls `wait_agents` with a bounded timeout (`BRAINROUTER_CHILD_DRAIN_TIMEOUT_MS`, default 30 s); timeout returns explicit child ids/statuses + `/continue` hint.
- **`task_agent` / `delegate_agent` split.** Foreground `task_agent` blocks with a timeout envelope; background `delegate_agent` returns a running id with a "continue working" hint. System prompt steers: direct → direct tool → task → delegate. `spawn_agent({ wait: true })` backward-compatible.
- **Child progress visibility in Ink.** Per-child tool rows (id, role, tool, duration, success/error, summary) plus a live "running children" status row while the parent waits.
- **Safe parallel execution for read-only tools.** Independent reads run via `Promise.allSettled`; writes/shell/orchestration stay serial; tool_result order preserved; unknown tools fail safe to serial.
- **Cron-style `/schedule`.** Standard 5-field cron alongside the existing `in 5m` / `at 14:30` one-shots. Persistent `.brainrouter/schedules.json`; in-process ticker with catch-up after sleep; `/schedule list|remove|enable|disable`.
- **`/release-notes` in-CLI.** Render current or past version notes inside the Ink REPL; `/release-notes list` enumerates bundled versions. Build ships `changelog/*.md` with the npm package.
- **Strict tool-call recovery.** Dedup duplicate tool_call ids; synthetic error tool_results on `JSON.parse` failures; orphan-result synthesis keeps OpenAI's strict pairing well-formed; unknown tool names return a "did you mean: <closest>" hint.
- **Per-vendor MCP install snippets.** `/mcp install <vendor>` for Claude Desktop, Cursor, Windsurf, VS Code Continue, Zed — paste-ready JSON with the active profile's URL/API key substituted. `/mcp install list` enumerates vendors with OS-resolved paths.
- **Native Anthropic `/v1/messages` adapter.** Talk Anthropic's native shape when the profile is Anthropic; `tool_use`/`tool_result` content blocks; system field extracted; opt-in prompt caching (`BRAINROUTER_ANTHROPIC_CACHE=1`); extended thinking on Claude 4-series Sonnet/Opus with `/effort high`. OpenAI path byte-identical for other providers.
- **Hooks JSON authoring doc.** New `brainrouter-docs/hooks.md` covers `.brainrouter/hooks.json` + `.brainrouter/hookify/*.json` schemas with three worked examples and debugging tips.
- **Ink question overlays.** `ask_user_choice` and `askYesNo` render through the active Ink chat overlay instead of the legacy raw stdout picker; single-select, multi-select, and `Other` fallback all supported.

## Fixes

- **Briefing now finds prefixed memory tools.** `🧠 Briefing: 0 records from (none)` no longer appears when the brain MCP exposes `mcp_brainrouter_memory_recall`. New `hasMcpTool` helper matches both bare and `mcp_<server>_<tool>` shapes.
- **Single-underscore tool naming standardised.** `mcp_<server>_<tool>` is canonical everywhere; double-underscore `mcp__<server>__<tool>` deprecated and normalised at the pool boundary. CI grep guard prevents regressions.
- **R1 guardrail recognises `task_agent` / `delegate_agent`.** Without this, `delegate_agent` silently bypassed the child-drain guardrail.
- **`task_agent` / `delegate_agent` access-mode gating.** Added to the read-only allowed-tool set.
- **`handleDelegateAgent` propagates errors verbatim** when there's no parseable child id, preserving both the failure message and the id the guardrail needs.
- **`handleWait` no longer leaks setTimeout handles.**
- **`parseInt` NaN guard for `BRAINROUTER_MAX_SPAWN_DEPTH`** — garbled env values fall back to the default (3) instead of disabling the cap.
- **JWT base64url tampering detection** — `verifyJwt` compares signatures in base64url string space; previous raw-byte comparison missed single-character padding-bit changes.

## [0.3.7] - 2026-05-26

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

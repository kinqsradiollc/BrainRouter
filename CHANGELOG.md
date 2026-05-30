# Changelog

All notable BrainRouter changes. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and versions
follow [SemVer](https://semver.org/spec/v2.0.0.html).

Use this file for the current release view. Full per-version notes live
in [`brainrouter-changelog/`](brainrouter-changelog/).

---

## Current Release View

| Version | State | Full notes |
|---|---|---|
| **0.4.3** | In flight | [`brainrouter-changelog/0.4.3.md`](brainrouter-changelog/0.4.3.md) |
| **0.4.2** | Shipped — 2026-05-30 | [`brainrouter-changelog/0.4.2.md`](brainrouter-changelog/0.4.2.md) |
| **0.4.1** | Shipped — 2026-05-29 | [`brainrouter-changelog/0.4.1.md`](brainrouter-changelog/0.4.1.md) |
| **0.4.0** | Shipped — 2026-05-28 | [`brainrouter-changelog/0.4.0.md`](brainrouter-changelog/0.4.0.md) |
| **0.3.9** | Shipped — 2026-05-28 | [`brainrouter-changelog/0.3.9.md`](brainrouter-changelog/0.3.9.md) |
| **0.3.8** | Shipped — 2026-05-26 | [`brainrouter-changelog/0.3.8.md`](brainrouter-changelog/0.3.8.md) |
| **0.3.7** | Shipped — 2026-05-26 | [`brainrouter-changelog/0.3.7.md`](brainrouter-changelog/0.3.7.md) |
| **0.3.6** | Shipped — 2026-05-25 | [`brainrouter-changelog/0.3.6.md`](brainrouter-changelog/0.3.6.md) |

Planning for future releases belongs in [`ROADMAP.md`](ROADMAP.md), not
this changelog.

---

## [0.4.3] - Unreleased

Feature-complete (memory depth MEM-1…14 + CLI-1…15), plus a post-investigation
hardening batch: the cost-telemetry `$0.00` fix (pricing family-fallback +
`inputCacheHit` NaN), the `/status` crash (#59) + in-memory config self-heal, a
recall-quality overhaul (correct security-intent detection, type-aware priority
caps, and a local no-latency lexical-relevance + MMR-diversity selection), and
provenance-safe transcript retention (`memory_prune_sources`) with the
`/sources` view hiding transcripts by default. Also wires the six previously
"idle · never" brain agents (vault export, blackboard reconcile, tree seal,
source re-chunk, self-retrieval `benchmark_eval`) with real executors +
auto-scheduling. Full notes accrue in
[`brainrouter-changelog/0.4.3.md`](brainrouter-changelog/0.4.3.md).

## [0.4.2] - 2026-05-30

Cross-vendor federation (Stage 5), CLI multi-agent Phases 5-6, durable
workflow run engine + live `/workflows` viewer, the full CLI-parity batch
(`/review --fix`, `/simplify`, `/effort xhigh|max`, `/model --session`,
`cli.fallbackModel`, `!` shell escape, `/rewind`, `/context`), version
centralization, and a docs refresh with an MCP API reference. Full notes:
[`brainrouter-changelog/0.4.2.md`](brainrouter-changelog/0.4.2.md).

## [0.4.1] - 2026-05-29

Shipped. Full notes in
[`brainrouter-changelog/0.4.1.md`](brainrouter-changelog/0.4.1.md).

### Added

- **Brain-side job queue + agent registry (BRAIN-P1, partial).** The
  `memory_jobs` table makes every brain-side action a durable,
  retryable row; the eight existing pipeline stages are formalised as a
  data-driven `BrainAgent` registry; and three read/observe MCP tools
  (`memory_agent_status`, `memory_agent_run`, `memory_job_retry`) let
  the CLI/dashboard inspect and re-arm brain work. Wiring the live
  pipeline onto each agent's `execute()` + runner loop (BRAIN-P1-T3) and
  the health surface (BRAIN-P1-T5) land in follow-ups.

---

## [0.4.0] - 2026-05-28

Persona injection (the anchor item — closes the gap where the brain
distilled a Core Identity but the CLI never injected it), federation
(shared memory + active-session registry + cross-CLI messaging),
CLI multi-agent Phase 2 (typed delegation), and the brain-side
design pass. Full notes in
[`brainrouter-changelog/0.4.0.md`](brainrouter-changelog/0.4.0.md).

### Added

- **Core Identity in the briefing prefix.** New `### Core Identity`
  section in every briefing, pinned into the 0.3.9 cache-stable
  prefix — zero token cost after turn 1, re-anchors only when the
  persona body changes.
- **`/persona` slash command.** Show / refresh / on / off the active
  Core Identity; back-compat `<name>` form preserved.
- **`memory_persona` + `memory_persona_refresh` MCP tools.** Brain
  exposes a canonical reader and on-demand distillation trigger,
  both returning a 16-char content hash.
- **`cli.personaAnchor` config knob.** System-wide on/off in
  `~/.config/brainrouter/config.json`. Per-workspace
  `personaAnchorEnabled` preference layered on top.
- **`/where` persona line and `/briefing` row.** Both surface anchor
  state so users can confirm the prefix actually carries it.
- **`/memories list [query]`.** Per-card precision badge
  `· cited N · uncited M (P%)` with a `⚠️ noisy` flag below 20% —
  makes pre-auto-archive memory quality visible.

### Federation Stage 1 (shared-memory foundation)

- **SQLite WAL hardening** — `journal_mode=WAL` is verified at boot
  and the brain logs a federation-aware warning when a host
  filesystem refuses WAL.
- **Per-client install snippets** for Claude Code, Codex, and
  Gemini CLI; federation primer added to
  [`brainrouter-docs/mcp-install.md`](brainrouter-docs/mcp-install.md).
- **`workspaceTag` on memories.** Optional 16-char hash that lets a
  CLI scope recall to a single workspace; NULL-tolerant so existing
  records stay visible during gradual rollout.

### Federation Stage 2 (active-session registry + cross-vendor presence)

- **Live peer presence.** New `session_register` /
  `session_heartbeat` / `session_unregister` / `session_list` MCP
  tools backed by an `active_sessions` table. Every
  BrainRouter-aware CLI / host (Claude Code, Codex, Cursor, Gemini
  CLI, …) attached to the same brain shows up as a row.
  Per-process identity: two terminals open in the same workspace
  show as two distinct sessions.
- **`/agents --remote`.** Lists peer sessions with `--watch`,
  `--usage`, `--include-stale`, `--json` flags. Auto-registers on
  REPL startup; heartbeats every 30 s; auto-recovers when the brain
  restarts; calls `session_unregister` on `/exit` so a clean shutdown
  removes the row immediately.
- **Live Sessions widget** on the dashboard Overview page, polling
  the new `/api/sessions` REST route every 10 s.
- **Per-session telemetry** — tokens / USD snapshot rides
  heartbeats. Opt-in via `--usage` (CLI) and `includeUsage: true`
  (REST / MCP). Heartbeats deliberately skip `operation_log` —
  audit volume guard.
- **Stale-session sweeper** runs every minute; sessions are
  swept 5 min after the last heartbeat.
- See [`brainrouter-docs/federation.md`](brainrouter-docs/federation.md)
  for the full lifecycle (active / stale / swept / recovered) and the
  privacy boundary.

### Federation Stage 3 (cross-CLI messaging)

- **`/dm <sessionKey> <message>`** — point-to-point text to another
  federated peer. Recipient sees an `📨` banner above their next
  prompt within ~5 s.
- **`/broadcast <message>`** — fans out to every active peer under
  your userId. `/broadcast <clientKind>:* <message>` narrows to
  one client kind (e.g. `claude-code:*`).
- **Three MCP tools.** `session_send` (writes one row per recipient
  — broadcast addresses are resolved against `active_sessions` at
  send time so each peer acks independently), `session_inbox_read`
  (default auto-acks; `peek: true` lets a crashy reader replay
  safely), `session_inbox_ack` (idempotent batch ack, up to 500
  ids per call).
- **Non-destructive banners.** The CLI's background inbox poll peeks
  and de-duplicates locally, so a visible `📨` banner remains available
  for a later explicit `session_inbox_read` when the user asks the
  agent to answer peer messages.
- **`kind` enum** accepts all five values (`text`, `tool-result`,
  `memory-ref`, `goal-handoff`, `delegate`) so Stage 4 and CLI
  Multi-Agent Phase 2 can carry structured payloads without a
  schema migration. Only `text` is rendered by Stage 3 CLIs.
- **Inbox sweeper** drops delivered rows older than 1 hour
  (configurable via `BRAINROUTER_INBOX_SWEEP_*`). Undelivered rows
  never sweep — they survive the recipient's downtime.
- **SSE push deferred.** Spec calls for SSE-fed notifications; the
  current implementation is a 5 s poll. Same UX, simpler surface.
  Tracked as a 0.4.1 follow-up.

### CLI Multi-Agent Phase 2 (typed delegation)

- **Synthesized `delegate_<agentId>` tools.** One per agent
  definition in the registry, rebuilt every turn. Description
  surfaces the agent's `whenToUse` so the LLM picks by reading
  the tool list (not by guessing role names). `spawn_agent` /
  `task_agent` stay as escape hatches.
- **`route_task` direct-first policy.** Returns a typed 4-tier
  decision: `answer-direct` / `direct-tool` / `spawn-inline` /
  `spawn-worker` with `recommendedTool`, `agentId`, `confidence`,
  `memoryEvidence`. `route_agent` becomes a deprecated alias.
- **Memory-aware routing.** When the brain is online,
  `route_task` queries past `agent_route_feedback` records via
  `memory_recall` and boosts confidence; offline path caps
  confidence at 0.6.
- **Parent execution context snapshot.** Typed packet handed to
  every child — memory refs (not bodies), plan/briefing
  excerpts, hashed workspace instructions. Persisted on the
  child session record AND written as the child's first
  transcript entry. `/agents show <id>` renders it. Same shape
  Stage 4 will use over the wire for cross-vendor delegate.
- **Typed output contracts** for the 5 built-in roles
  (explorer / architect / reviewer / worker / verifier). The
  child's system prompt gains a "Required structured output"
  block; `parseChildOutput` parses the result tolerantly.
- **`agent_route_feedback` emitter** on every child completion.
  Records the routing decision + outcome via `memory_capture_turn`
  so future `route_task` calls can learn from history.

### Brain-side design pass (0.4.0 — design only)

- **`BrainAgent` interface** exported from
  `@kinqs/brainrouter-types`. Captures the agent registry shape
  (`id`, `description`, `inputSchema`, `outputSchema`, `modelClass`,
  `maxAttempts`, `timeoutMs`, `batchSize`, `idempotencyKey`,
  `reads`, `writes`, `emits`, `dependsOn`). Phase 1 implements.
- **`MemoryJobRecord` + `MemoryJobStatus`** — type stubs for the
  observable, retryable job queue that replaces today's scattered
  setInterval handles + ad-hoc retry logic.
- **`MemoryBlackboardItem`** — the candidate-memory layer Phase 5
  uses to chain dedup / contradiction / evidence agents before a
  record lands.
- **[`brainrouter-docs/brain-agents.md`](brainrouter-docs/brain-agents.md)** —
  full design freeze: registry inventory with locked-in agent IDs,
  SQL sketches, retry-with-backoff lifecycle, MCP tool schemas
  (`memory_agent_status` / `memory_agent_run` /
  `memory_job_retry`), and the Phase 1 implementation layout.
- **Zero runtime change.** Types are importable today; the brain
  pipeline still runs the existing scattered stages. Phase 1
  (0.4.1) ships the runtime against this contract.

---

## [0.3.9] - 2026-05-28

Memory briefing quality, cache-first context, tool-call repair,
cost-control, and CLI configuration cleanup.

### Breaking / Removed

- CLI `.env` loading removed; behavior settings now live under `cli.*`
  in `~/.config/brainrouter/config.json`.
- Native Anthropic `/v1/messages` adapter removed; Claude remains
  reachable through OpenAI-compatible gateways.
- CLI recall fallback wrapper removed; the brain-side recall pipeline
  owns fallback behavior.

### Added

- Adaptive, source-aware memory briefing with `/briefing` inspection.
- Read-only source manifest via `/memories sources [limit]`.
- Cache-first context regions and prefix-pinned memory cards.
- Cache-hit telemetry, tool-call repair, turn-end tool-result shrink,
  model-tier self-escalation, and cost/cache reporting in `/tokens`.

### Changed

- CLI behavior knobs consolidated into typed `config.json` fields.
- Model/provider/API-key-prefix catalogs moved to JSON files.
- LM Studio `/api/v1/models` metadata appears in `/status` and the
  wizard when using the local LM Studio endpoint.
- Provider picker slimmed to OpenAI, LM Studio, and Ollama; OpenAI is
  the custom OpenAI-compatible endpoint path.
- Memory capture redacts secrets and blocks credential-shaped payloads.

---

## [0.3.8] - 2026-05-26

CLI delegation reliability, parallel reads, native Anthropic adapter,
and quick wins carried from 0.3.7.

- Runtime child-drain guardrail prevents prose-only fake waiting while
  child agents are still running.
- `task_agent` and `delegate_agent` split foreground vs background
  child work.
- Child progress rows, Ink question overlays, and visible yes/no
  approvals improve REPL feedback.
- Safe read-only tool calls can run in parallel while writes remain
  serialized.
- `/schedule`, `/release-notes`, hooks docs, strict tool-call recovery,
  and per-vendor MCP install snippets shipped.
- Briefing now finds prefixed memory tools; `mcp_<server>_<tool>` is the
  canonical MCP tool-name form.

## [0.3.7] - 2026-05-26

Terminal UI redesign, in-terminal configuration, full Ink chat REPL, and
multi-agent registry foundations.

- Full Ink chat REPL, slash palette, first-run wizard, `/config`,
  `/login`, `/init`, and live `/model` picker.
- Multi-profile MCP manager with hot connect/disconnect/reconnect.
- Data-driven built-in agent registry and spawn-tier/depth rules.
- CLI/server env separation so server logs no longer bleed into the UI.

## [0.3.6] - 2026-05-25

Smarter recall, friendlier CLI, and a more reliable agent loop.

- Multi-workflow switching and workflow listing.
- `/effort`, `/mode`, `/review-policy`, `/grill-me`, and mid-turn
  `ask_user_choice`.
- Static prompt cut from about 4,750 tokens to about 1,400 tokens, with
  gated recall and deduplicated goal anchors.
- MCP identity detection, offline UX, and multi-MCP foundations.

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

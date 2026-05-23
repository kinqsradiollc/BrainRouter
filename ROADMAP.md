# BrainRouter Roadmap

Active released version: **0.3.5** — global-install UX fix
(`brainrouter-mcp init`, env-loader priority chain, README rewrites for
global-install users). Shipped to npm. See [`CHANGELOG.md`](CHANGELOG.md).

In-flight: **0.3.6** — Stage 4 relevance judge, dashboard
markdown/Mermaid/KaTeX, `.env` template reorg, goal-loop hardening, LLM
pipeline robustness fixes. Goal-leakage bug (Item 1), JSON-repair
hotfix (Item 0), and CLI shell redesign (Item 2) shipped. Remaining
planned items in "In-flight for 0.3.6" below: `ask_user_choice` tool,
reasoning-step capture, multi-workflow concurrency.

Next major target: **0.4.0 — Federation** (multi-CLI, multi-instance, shared
memory). Design sketched below in "Next Major Release."

---

## Recently Completed

### 0.3.6 — Relevance judge, goal-loop hardening, dashboard markdown (in-flight)
- **Stage 4 relevance judge.** Opt-in LLM-as-judge gate runs *after* the reranker and drops candidates that share vocabulary with the query but aren't actually relevant. Verdicts are auditable via `RecallExplanation.judgeVerdicts[]`. Falls back to reranker output on any failure — a flaky judge never breaks recall. ([`brainrouter/src/memory/store/relevance-judge.ts`](brainrouter/src/memory/store/relevance-judge.ts), [`brainrouter/src/memory/recall.ts`](brainrouter/src/memory/recall.ts))
- **Goal-loop hardening.** Per-turn `goal-anchor` system message re-injection so the goal stays in immediate context across long `/goal` loops; `Agent.ensureInitialized()` resolves the MCP sessionKey before the first `runTurn` (fixes the split-brain where the first `/goal` wrote to the fallback key); `/plan clear` escape hatch for stale plan items; inline `budget: N iterations` parsing in `/goal`; auto-reconcile of stale plan items on a new goal. ([`brainrouter-cli/src/agent/agent.ts`](brainrouter-cli/src/agent/agent.ts), [`brainrouter-cli/src/cli/commands/workflow.ts`](brainrouter-cli/src/cli/commands/workflow.ts))
- **Default goal budget effectively unlimited.** `DEFAULT_GOAL_BUDGET` raised `10` → `1_000_000` with a new `formatBudget()` that renders ≥100k as "unlimited"; anti-spin, repeat-loop, and manual `/goal pause` remain the real safety nets. Continuation prompt rewritten with an explicit re-anchor block, drift check, and a "tool-call mechanics" reminder. ([`brainrouter-cli/src/state/goalStore.ts`](brainrouter-cli/src/state/goalStore.ts), [`brainrouter-cli/src/cli/repl.ts`](brainrouter-cli/src/cli/repl.ts), [`brainrouter-cli/src/prompt/systemPrompt.ts`](brainrouter-cli/src/prompt/systemPrompt.ts))
- **Fan-out veto detector.** Phrases like "no spawn_agent", "do this in one turn", "directly with read_file" now hard-veto high breadth scores and surface as `vetoed:<phrase>` signals. ([`brainrouter-cli/src/prompt/breadthHint.ts`](brainrouter-cli/src/prompt/breadthHint.ts))
- **Dashboard markdown, Mermaid, KaTeX.** Chat bubbles render via a new shared `Markdown` component with LaTeX (`remark-math` + `rehype-katex`, auto-normalizes `\[…\]` / `\(…\)` / named math envs); Working Memory canvas swaps `<pre>` for a theme-aware `Mermaid` component; Persona and `SceneCard` migrate to the same shared component. ([`brainrouter-dashboard/components/Markdown.tsx`](brainrouter-dashboard/components/Markdown.tsx), [`brainrouter-dashboard/components/Mermaid.tsx`](brainrouter-dashboard/components/Mermaid.tsx))
- **`.env` templates reorganized.** Numbered sections in both `brainrouter/.env.example` (5 sections) and `brainrouter-cli/.env.example` (6 sections); placeholder strings blanked so committed examples never look like real secrets. New `BRAINROUTER_RELEVANCE_JUDGE_*` tunables documented.
- **LLM-pipeline robustness fixes.** Relevance judge now survives LM Studio's idle-model auto-unload (detects "no models loaded" / "model is unloaded" 400, waits 1.5s, retries once — mirrors `ModelLLMRunner`). Cognitive extractor no longer drops a whole batch over one bad JSON escape: new `parseJsonWithEscapeRepair` doubles any `\X` that isn't a legal JSON escape and retries the parse, so Windows paths / LaTeX / regex literals in `content` fields parse cleanly. ([`brainrouter/src/memory/store/relevance-judge.ts`](brainrouter/src/memory/store/relevance-judge.ts), [`brainrouter/src/memory/pipeline/cognitive-extractor.ts`](brainrouter/src/memory/pipeline/cognitive-extractor.ts))
- **JSON-repair path-escape correctness fix** (PR #22). The original `parseJsonWithEscapeRepair` preserved `\b\f\n\r\t` and `\uXXXX` as JSON escapes during repair, which silently corrupted Windows paths and Unix path segments starting with those letters (`\bin`, `\target`, `\release`, etc.). Repair now only preserves `\"`, `\\`, `\/`; everything else doubles to literal. Tradeoff: legitimate `\n` in repair-branch content becomes literal two-char `\n`; happy-path `\n` still becomes a newline. New test file [`brainrouter/src/__tests__/cognitive-extractor.test.ts`](brainrouter/src/__tests__/cognitive-extractor.test.ts) covers the four pathological path inputs and the unicode-escape tradeoff (4 tests, all passing).
- **Goal-leakage across CLI sessions fixed** (PR #26). Two leaks closed. Primary: `agent.ts` now defaults `sessionKey` to `randomUUID()` instead of the workspace-derived `brainrouter-cli:<workspaceRoot>` string. The old default failed MCP's `isUniqueId` check in [`memory_resolve_session`](brainrouter/src/tools/memory_resolve_session.ts), forcing the workspace-cache branch — which returned the same UUID to every CLI launched in the workspace, so concurrent CLIs read/wrote the same goal/plan/working bucket. UUIDs pass `isUniqueId` and are echoed back unchanged, so each CLI process is its own session for local state. Memory recall is unaffected (DB is userId-scoped). Secondary (defense-in-depth): `readGoal(workspace, sessionKey)` no longer silently falls through to the legacy workspace-level `cli/goal.json` when the session bucket is empty; any leftover legacy file is archived to `getCliStateDir(workspace)/.brainrouter.migrated/legacy-goal-<ts>.json` on first session-scoped `setGoal`. Banner now surfaces the session prefix so two concurrent CLIs are visually distinct from launch. ([`brainrouter-cli/src/agent/agent.ts`](brainrouter-cli/src/agent/agent.ts), [`brainrouter-cli/src/state/goalStore.ts`](brainrouter-cli/src/state/goalStore.ts), [`brainrouter-cli/src/cli/repl.ts`](brainrouter-cli/src/cli/repl.ts))
- **CLI shell redesign shipped** (PR #27). Boxed startup banner replaces the three-line text dump (workspace, MCP, workflow, goal, session, model in one block); new `/where` collapses orientation-state (workspace + workflow + goal + plan + recall + children) into a single screen so users don't chain four commands to know where they are; statusline extended with `workflow` / `goal` / `plan` / `pr` segments; `/quiet` and `brainrouter --quiet` hide recall tables, briefing dumps, and tool-completion previews; new [`brainrouter-cli/src/cli/theme.ts`](brainrouter-cli/src/cli/theme.ts) consolidates colors with `BRAINROUTER_THEME=dark|light|mono` and the readline prompt + access-mode accent now consume those tokens; bare `?` opens `/help` and a one-time idle hint fires after 30s of silence; Node's `ExperimentalWarning` and dotenv noise no longer scroll the banner off-screen, filtered via a CJS bin shim at [`brainrouter-cli/bin/cli.cjs`](brainrouter-cli/bin/cli.cjs) that installs the listener BEFORE the ESM CLI's hoisted `import 'node:sqlite'` fires the warning. Also bundled: `/tokens` now scopes child usage by `parentSessionKey === agent.sessionKey` (fresh runs no longer show inflated "31 children" from prior workspace sessions); `/resume` / `/fork` zero in-process parent counters; the synthetic 5× memory-savings heuristic is dropped in favor of measured offload chars. New [`brainrouter-cli/src/cli-shell.test.ts`](brainrouter-cli/src/cli-shell.test.ts) brings the suite to 141 tests (was 115). ([`brainrouter-cli/src/cli/banner.ts`](brainrouter-cli/src/cli/banner.ts), [`brainrouter-cli/src/cli/statusline.ts`](brainrouter-cli/src/cli/statusline.ts), [`brainrouter-cli/src/cli/whereView.ts`](brainrouter-cli/src/cli/whereView.ts), [`brainrouter-cli/src/cli/repl.ts`](brainrouter-cli/src/cli/repl.ts))
- **CI / Dependabot hardening.** First-run `directories:` (plural) replaced with `directory: /` for npm workspaces; major-bump PRs ignored during 0.3.6 stabilization; `react-ecosystem` group added so React + React-DOM always bump together (prevents the "Incompatible React versions" Next.js failure). Root `build` script split into dependency-ordered `build:packages` + `build:apps` phases; redundant `dashboard-build` CI job removed. CI matrix narrowed to Node 22.x only (matching `engines.node >= 22.0.0`).
- **Flaky JWT-tampering test fixed.** `brainrouter/src/__tests__/crypto.test.ts` was hard-coding `"x"` as the tampering character; when the JWT signature happened to end in `"x"` (~1/64 base64url collision odds) the "tampered" token equalled the original and the test failed intermittently. Replacement char now guaranteed to differ. Side effect: the Node 20.x ci.yml comment that blamed `crypto.timingSafeEqual` was wrong — it was this flakiness.
- **Docs.** New "Relevance judge" section in [`brainrouter-docs/configuration.md`](brainrouter-docs/configuration.md) with three setup recipes; recall-pipeline diagram in [`brainrouter-docs/memory-engine.md`](brainrouter-docs/memory-engine.md), [`BRAINROUTER.md`](BRAINROUTER.md), and [`PRESENTATION.md`](PRESENTATION.md) updated to show the judge as the final gate; README aligned with the new placeholder-blank style. New [`CLAUDE.md`](CLAUDE.md) (Claude Code repo instructions) + [`Tasks.md`](Tasks.md) (0.3.6 living checklist) + [`openSrc/REFERENCES.md`](openSrc/REFERENCES.md) (router for vendored research material; gitignored). PR + issue templates + Dependabot config added under [`.github/`](.github/).
- **Tests.** New coverage for breadth-hint vetoes, goal-budget formatter, and `goalHasBudgetLeft` under the effectively-unlimited default ([`brainrouter-cli/src/agent.test.ts`](brainrouter-cli/src/agent.test.ts)) plus the new cognitive-extractor and crypto fixes above.

### 0.3.5 — Global-install UX fix (shipped)
- **`brainrouter-mcp init` subcommand.** Scaffolds `~/.config/brainrouter/server.env` from the bundled `.env.example` (chmod 0600). Won't overwrite an existing file.
- **MCP env-loader priority chain.** Three slots, in order: `$BRAINROUTER_ENV_FILE` → `~/.config/brainrouter/server.env` → `./.env`. Server prints which file it loaded at startup.
- **Published READMEs rewritten for global-install users.** Both `@kinqs/brainrouter-cli` and `@kinqs/brainrouter-mcp-server` now document the install + configure + run flow that ends with `brainrouter` on `$PATH`, including the sudo caveat (don't sudo if you're on nvm/Homebrew).
- **`SETUP.md` restructured** into §2A (install from npm) and §2B (clone and build).
- Backward compatible: existing monorepo dev (`brainrouter/.env`) still works in the third priority slot. 109 CLI tests still passing.

### 0.3.4 — First npm release
- **Published packages**: [`@kinqs/brainrouter-cli`](https://www.npmjs.com/package/@kinqs/brainrouter-cli) (CLI — installs the `brainrouter` binary), [`@kinqs/brainrouter-mcp-server`](https://www.npmjs.com/package/@kinqs/brainrouter-mcp-server), [`@kinqs/brainrouter-sdk`](https://www.npmjs.com/package/@kinqs/brainrouter-sdk), [`@kinqs/brainrouter-types`](https://www.npmjs.com/package/@kinqs/brainrouter-types). License, repository, keywords, `publishConfig.access: public`, `files` allowlist, and `prepack` hooks on each.
- **CLI offline mode**: degrades cleanly when the MCP server is unreachable instead of hard-exiting; `--strict-mcp` opts back into the old fail-fast behavior. Startup banner surfaces `⚠️  OFFLINE MODE`.
- **CLI inspection-tool previews**: `list_dir`, `grep_search`, `glob_files` now render their results indented under the tool-completion line, so users see the content even when small models forget to echo it.
- **CLI env separation**: `~/.config/brainrouter/config.json` is the canonical source for chat-LLM creds; `.env` loading is restricted to runtime knobs (sandbox, timeouts, trace log, web search). Removed silent LLM-cred precedence bug where `brainrouter/.env` could shadow `config.json`.
- **bash/shell tool alias**: `bash`, `Bash`, `shell`, `sh` all route to `run_command` for cross-vendor model familiarity (Claude Code parity).
- **README**: documents the two-config (MCP env vs CLI config.json) split, the install-from-npm path, MCP-required-for-full-power dependency, and the offline-mode escape hatch.



### Dashboard & Backend
- **Hardened Dashboard Authentication**: "Remember Me" for session JWT persistence, dynamic JWT cleanup after API validation failures, signup password strength validation, and descriptive error messages.
- **Admin User Management**: Paginated tables, user creation forms, enable/disable status controls, API key reset dialogs, delete confirmation flows, and self-protection overrides.
- **Memories Management Hub**: Keyword search, classification type filters, active/archived toggles, infinite scroll, inline content editing, and multi-select bulk actions.
- **Developer Profiles**: displayName updates, API key rotation, masked keys with click-to-copy, copyable connection JSON blocks.
- **MCP Onboarding Assistance**: Dismissible banner showing copyable SSE configurations for connecting desktop clients to local server instances.
- **Cognitive Operations Monitoring**: Contradiction resolution workflows, sidebar pending contradiction badges, evidence kind filtering, recent memory activity feeds.
- **Backend Quality of Service**: Client IP-based rate limiting on auth routes, input length sanitization, CORS support.

### Terminal Agent CLI
- **`brainrouter` CLI**: Node-based interactive REPL with theme-aligned dark console. 60+ slash commands across session / memory / workflow / orchestration / guard / obs / ui surfaces.
- **Dynamic configuration**: `~/.config/brainrouter/config.json` supports both local stdio and remote HTTP MCP transports.
- **Dual-system reasoning**: Pre-turn memory briefing (System 1 recall) + post-turn `memory_capture_turn` (System 2 consolidation).
- **Local execution tooling**: Sandboxed `run_command`, `read_file`, `write_file`, `apply_patch`, `web_search`, plus the full MCP tool registry.
- **Goal state machine**: `usage_limited` status, token + iteration budgets, replace-confirmation prompt, wrap-up steering on the final budget turn, `/goal edit` unified mutation.
- **Multi-agent orchestration**: `spawn_agent` with explorer / architect / reviewer / worker / verifier roles, durable workflow folders (`spec.md` / `tasks.md` / `walkthrough.md`), auto-review pass.

---

## Next Major Release

### v0.4.0 — Federation: many agents, one memory

**Theme.** Today BrainRouter is a single-user, single-CLI tool: one
`brainrouter` REPL talking to its own MCP server. v0.4.0 turns it into a
shared memory plane that *any* MCP-aware CLI (BrainRouter CLI, Claude Code,
Codex, Cursor, Gemini CLI, Hermes, OpenClaw, …) can attach to, with the
agents able to see one another, hand off work, and contribute to a single
user-scoped memory pool. The same machinery makes "I have five
`brainrouter` windows open across three repos" a first-class scenario
rather than a coincidence that happens to mostly work.

#### Scenarios this unlocks

- **One memory across vendors.** "I drafted a spec in BrainRouter CLI this
  morning. Now I'm in Claude Code in the same repo — Claude should already
  know the constraint I captured." Both CLIs point at the same BrainRouter
  MCP; both recall the same memory rows.
- **Cross-CLI handoff.** Codex finishes scaffolding the implementation, then
  hands the in-progress `/goal` to a BrainRouter CLI session for the review
  pass — including the active plan, working-memory steps, and cited
  evidence. The receiving CLI picks up where Codex left off.
- **Multi-window awareness.** Three `brainrouter` REPLs open across three
  projects. Each one knows the others exist, can list them with
  `/agents --remote`, and can broadcast or address messages between them
  without leaving the terminal.
- **Delegation across vendors.** A BrainRouter CLI agent calls
  `delegate_task("codex", …)`; the BrainRouter MCP routes the payload to
  whichever Codex CLI session is registered and idle, or queues it until
  one comes online.

#### Architectural plan (five stages — staggered across 0.4.x)

**Stage 1 — Shared-memory foundation (0.4.0 MVP)** *— mostly already in
place, needs hardening and docs.*

- HTTP MCP transport (`npm run dev:http`, port 3747) is already the
  primitive. Any number of clients sharing the same userId (resolved via
  `BRAINROUTER_API_KEY`) automatically share their memory pool.
- **Verify SQLite WAL mode is enabled** on the shared db — required for
  concurrent reads and a writer; without it, parallel writes serialize and
  long-running extractions block every other client's recall.
  ([`brainrouter/src/memory/store/sqlite.ts`](brainrouter/src/memory/store/sqlite.ts))
- **Per-client install docs.** Walk-throughs for adding BrainRouter MCP to
  Claude Code (`~/.claude/mcp.json`), Codex (`~/.codex/mcp.json` or
  equivalent), Cursor (`.cursor/mcp.json`), and Gemini CLI. Each gets a
  copy-pasteable JSON snippet keyed by their per-user API key.
- **Workspace tagging on memories.** Today everything is userId-scoped. Add
  an optional `workspaceTag` so a Codex CLI editing project A doesn't recall
  noise from project B. Default: pass through the workspace root hash.
  ([`packages/types/src/memory.ts`](packages/types/src/memory.ts) — extend
  `CognitiveRecord`; [`brainrouter/src/memory/recall.ts`](brainrouter/src/memory/recall.ts)
  — extend `RecallFilters`.)

**Stage 2 — Active-session registry & discovery (0.4.0 MVP)**

- **New table `active_sessions`** in the SQLite store: `(sessionKey,
  userId, clientKind, workspaceRoot, startedAt, lastHeartbeatAt,
  metadata_json)`. `clientKind` is a free-form string the client
  self-reports: `brainrouter-cli`, `claude-code`, `codex`, `cursor`,
  `gemini-cli`, `http-unknown` (fallback).
- **Two new MCP tools:**
  - `session_register({ clientKind, workspaceRoot, metadata })` — called
    once at client startup. Returns a stable `sessionKey`. Idempotent if
    the client passes its own `sessionKey`.
  - `session_heartbeat()` — called every 30s. Updates `lastHeartbeatAt`.
- **One new MCP tool for discovery:**
  - `session_list({ userId?, clientKind?, workspaceRoot?, includeStale })`
    — returns active peers. Default filter: `lastHeartbeatAt < 2 min`.
- **Sweeper:** background job that drops rows with `lastHeartbeatAt` older
  than 5 minutes. Belongs alongside the existing extraction sweeper in
  [`engine.ts`](brainrouter/src/memory/engine.ts).
- **CLI surfacing:** `/agents --remote` lists peers; `/agents --remote
  --watch` opens a live SSE-fed view.
- **Dashboard widget:** "Live sessions" panel on the home page —
  client kind, workspace, last heartbeat, idle/active.

**Stage 3 — Cross-CLI messaging (0.4.0 MVP)**

- **New table `session_inbox`:** `(id, fromSessionKey, toSessionKey ('*'
  for broadcast), kind, payload_json, createdAt, deliveredAt?)`. `kind` is
  one of: `text`, `tool-result`, `memory-ref`, `goal-handoff`, `delegate`.
- **Three new MCP tools:**
  - `session_send({ to, kind, payload })` — enqueue. `to` can be a
    sessionKey, a `clientKind:*` pattern, or `*` (broadcast within the
    user's pool).
  - `session_inbox_read({ since, limit })` — pull undelivered messages
    addressed to me. Marks them delivered on read; pass `peek: true` to
    not consume.
  - `session_inbox_ack({ ids })` — explicit acknowledgement, used when a
    receiver wants to confirm processing distinct from "read."
- **Transport:** the HTTP MCP server already speaks Streamable HTTP — push
  inbox events down the same channel as an SSE-style notification so
  receivers don't have to poll. Stdio clients fall back to a 5s poll on
  `session_inbox_read`.
- **CLI surfacing:** `/dm <sessionKey> <msg>` for point-to-point,
  `/broadcast <msg>` for the user's whole pool. Incoming text messages
  surface as a banner above the next prompt.

**Stage 4 — Work handoff (0.4.1)**

- **Handoff packet:** `{goal, plan, workingMemorySteps, citedRecordIds,
  recentTranscript, originatingClient, originatingWorkspace}`. Serialized
  into `session_inbox.payload_json` with `kind: "goal-handoff"`.
- **Sender side:** new CLI command `/handoff <targetSession>` (or
  `<clientKind>:next-idle`) on BrainRouter CLI. Packs the current `/goal`
  state and ships it. Sender's local goal transitions to `paused` with
  reason `handed-off-to:<target>`.
- **Receiver side:** when the inbox surfaces a `goal-handoff`, the
  receiving REPL shows a confirmation: "Codex has handed you this task.
  Goal: …. Accept and start (y/N)?" On accept, the receiver creates a new
  `/goal` populated from the packet, with a system message tagged
  `handoff-context` summarizing the predecessor's plan/steps.
- **Non-BrainRouter receivers (Claude Code, Codex):** they don't have
  `/goal`, but they do have MCP. The handoff still lands in their inbox;
  it surfaces via `memory_recall` as a high-priority `handover_note`
  memory until acknowledged. (We already have `handover_note` as a
  cognitive type — [`memory.ts`](packages/types/src/memory.ts).)

**Stage 5 — Cross-vendor delegation (0.4.2 stretch)**

- **Normalized delegate payload:** `{goal, files, constraints, modelHints,
  budget, deadline}`. Vendor-agnostic — describes the task, not the tool.
- **`delegate_task({ agentKind, payload })`** MCP tool. Resolves
  `agentKind` against the active-sessions registry; if an idle peer with
  matching `clientKind` exists, enqueue to its inbox. If none, queue the
  payload as a `pending_delegation` row and pick the first matching
  session to come online.
- **Vendor adapters.** Each `clientKind` gets a small translator that maps
  the payload into the vendor's native prompt shape:
  - `claude-code`: drop the payload into a system message and queue a
    user-message prompt; rely on Claude Code's MCP tools for execution.
  - `codex`: same shape, slightly different prompt template.
  - `brainrouter-cli`: convert into a `/goal` + `/plan add` sequence.
- **Spawn-on-demand (deferred, possibly 0.5.x).** If no peer of the
  requested kind is online, optionally spawn one (via tmux pane, Docker
  container, or remote SSH) using the existing terminal-backend ideas
  from [`hermes-agent/`](openSrc/hermes-agent/). Out of scope for v0.4.x —
  flagged here so we don't paint ourselves into a corner now.

#### Multi-instance-same-CLI subset (free with Stages 1–3)

The "five BrainRouter CLIs open" case falls out of the same machinery:

- Each instance registers via `session_register`, gets a unique
  `sessionKey`, heartbeats every 30s.
- `/agents --remote` lists the other four.
- `/dm` and `/broadcast` work between them with no special-case code.
- Memory is already shared via the common userId (Stage 1).
- Working memory remains **per-session** (each CLI has its own
  `~/.brainrouter/work/<user>/<hash>/<session>/`) — no change needed.
  Memories captured in any session are visible to all on next recall.

#### Open questions to resolve before locking 0.4.0

- **Memory scope by default.** Should Claude Code's recall see
  BrainRouter CLI's captured memories by default, or should there be an
  explicit "share with cross-vendor sessions" flag per memory? Leaning
  toward default-share within a single userId, with an opt-out memory
  type modifier — but worth a design pass.
- **Privacy of working memory.** Working steps (`steps.jsonl`) currently
  log the full agent trace. If two vendors share a session pool, should
  one vendor's working memory be readable by another? Default: no
  (per-session, not cross-readable). Cognitives only are shared.
- **Authentication model for federated HTTP MCP.** Today each CLI is
  expected to have its own `BRAINROUTER_API_KEY`. For federation we need
  to decide whether multiple users can attach to the same MCP instance
  (multi-tenant server mode) or whether each user runs their own MCP and
  federation is strictly per-user across many CLIs. Current bias:
  per-user (simpler, matches existing API key model).
- **Conflict resolution on simultaneous writes.** Two CLIs update the
  same memory in the same turn. Current behavior is last-write-wins via
  `updatedTime`. Probably acceptable; document it explicitly in
  [`brainrouter-docs/memory-engine.md`](brainrouter-docs/memory-engine.md).
- **Heartbeat cost.** A 30s heartbeat at scale (say, 10 active sessions
  per user, 10 users on a shared MCP) is one write/sec. SQLite handles
  this trivially, but the audit log volume needs care — heartbeats
  should NOT write to `operation_log`.
- **Stdio fallback for federation.** Stdio MCP is one-process-one-client
  by design. Stage 2/3 mostly Just Work via the inbox table polling, but
  there's no SSE push. Document that federation is best-experienced over
  HTTP MCP; stdio works but is laggy.

#### Migration story

- **Existing stdio installs keep working.** Federation features are
  opt-in by switching to HTTP MCP. No flag flips on stdio users.
- **Backwards-compatible schema.** New tables (`active_sessions`,
  `session_inbox`) are additive. Existing memories don't need
  re-embedding or re-extracting.
- **CLI version skew.** A v0.4.0 BrainRouter CLI attached to a v0.3.5
  MCP server should fail gracefully (the new MCP tools return
  `unknown_tool`); the CLI degrades to single-session behavior with a
  startup banner explaining the gap.

#### Reference reading (already on disk under [`openSrc/`](openSrc/REFERENCES.md))

- **`hermes-agent/`** — multi-channel gateway shape, terminal backends.
  Most relevant to Stage 5 (spawn-on-demand) and the broader "agent
  reachable from anywhere" UX.
- **`agentmemory/`** — peer MCP for memory; useful when sanity-checking
  whether our `session_*` tools shape matches the ecosystem.
- **`chrome-devtools-mcp/`** — Google's tool-shape style guide;
  consult before locking the names/args on the six new MCP tools above.
- **`agentscope/`** — multi-agent message passing patterns; relevant to
  Stages 3 and 4.
- **Pi Intercom** *(not yet vendored — see
  [`openSrc/REFERENCES.md`](openSrc/REFERENCES.md) wishlist)* — how
  Inflection ships cross-device handoff to end users; useful UX
  reference for the v0.4.1 handoff flow.

---

## In-flight for 0.3.6

Three remaining workstreams (items 3–5) beyond what's already shipped in
0.3.6 (judge, goal-loop hardening, dashboard markdown, env reorg, pipeline
fixes, CI bootstrap, the JSON-repair path-escape fix, the goal-leakage
fix, and the CLI shell redesign — see "Recently Completed → 0.3.6"
above). Items 3–5 are designed features; the live progress checklist
lives in [`Tasks.md`](Tasks.md). Items 1 and 2 are retained below as
post-mortems on the bug + redesign that shipped in PR #26 and PR #27
respectively.

### 1. Goal-leakage across sessions (✅ shipped in PR #26)

**Symptom (reported by user).** Open a new CLI session, type `/goal …`,
get a `GoalConflictError` showing a goal from a *previous* session in the
same workspace:

```
brainrouter[shell]> /goal let's discover our brainrouter
⚠️  A goal is already active:
     explore the whole codebase
     2/unlimited iterations used
Replace it with the new objective? (y/N)
```

**Root cause.** `readGoal` falls back to a workspace-level CLI state file
when the session-scoped `goal.json` doesn't exist yet
([`goalStore.ts:173-176`](brainrouter-cli/src/state/goalStore.ts:173)):

```ts
const legacyPath = getCliStateFile(workspaceRoot, 'goal.json');
if (fs.existsSync(legacyPath)) {
  return normalize(readJsonFile<Partial<Goal> | null>(legacyPath, null));
}
```

So even though new sessions get a fresh sessionKey, every `readGoal`
inside that session finds and returns the OLD workspace-scoped file
written by an earlier session. Effective scope today is **per-workspace,
not per-session** — opposite of what the API name suggests and what the
docs claim.

**Fix.**

- **Stop reading the legacy path on new sessions.** When a sessionKey is
  passed, `readGoal` should return `null` if the session-scoped file
  doesn't exist — never silently fall back. The legacy path remains for
  the no-sessionKey branch (purely for backwards-compat reads from very
  old installs that never had session-scoped goals).
- **One-shot migration.** On the FIRST `setGoal` call of any new
  session, if a legacy workspace `goal.json` exists, *rename* it to
  `<workspace>/.brainrouter.migrated/legacy-goal-<timestamp>.json`
  instead of leaving it where future sessions can pick it back up.
- **Add a test.** "Setting a goal in session A, opening session B,
  calling `readGoal(B)` returns null." Currently this test would fail.

**Affected callers to double-check after the fix:**

- `/goal` slash handler in
  [`workflow.ts:373+`](brainrouter-cli/src/cli/commands/workflow.ts:373)
- The eager-init path in
  [`agent/agent.ts`](brainrouter-cli/src/agent/agent.ts) that bootstraps
  the session key before `runTurn`.
- Goal-continuation loop in
  [`cli/repl.ts`](brainrouter-cli/src/cli/repl.ts) (the `setTimeout`
  re-arm after a turn completes).

### 2. CLI shell redesign (✅ shipped in PR #27)

**Symptom.** Startup output was technical noise: a Node
`ExperimentalWarning` from `node:sqlite` followed by two free-form
`console.log` lines (`Workspace: …`, `Connecting to MCP server profile
"local-http"…`) and then a green `Successfully connected!` — all of
which scrolled real content off-screen on short terminals. Once the
REPL was up there was no visible state: no current workflow, no goal
status, no session id, no model. Users had to chain `/goal status`,
`/workflows`, `/agents`, `/config` separately just to orient.

**Fix.** Seven sub-deliverables landed together as one PR (the surfaces
all touched the same REPL chrome so splitting would have produced
churn for no review-quality gain):

- **Boxed startup banner.** New pure renderer
  [`brainrouter-cli/src/cli/banner.ts`](brainrouter-cli/src/cli/banner.ts)
  draws a single Unicode box with workspace + short-hash, MCP profile +
  transport + online/offline, current workflow (if bound), goal status
  + budget, session prefix, model. Sections silently omit when empty so
  a fresh workspace renders only the rows that apply. The three
  pre-banner `console.log` lines (workspace / connecting / success)
  were deleted — `/workspace` exposes the launch CWD + detection reason
  on demand, and the banner itself IS the success signal.
- **`/where` single-screen state.**
  [`brainrouter-cli/src/cli/whereView.ts`](brainrouter-cli/src/cli/whereView.ts)
  gathers workspace, active workflow + meta, goal status + budget, plan
  items, recent recall (with priorities), and live child sessions, then
  renders themed sections. Empty sections drop out, so the output stays
  proportional to actual state.
- **Persistent status line.** New
  [`brainrouter-cli/src/cli/statusline.ts`](brainrouter-cli/src/cli/statusline.ts)
  centralizes segment renderers. Added `workflow`, `goal`, `plan`, `pr`
  alongside the existing `mode`, `model`, `tokens`, `session`,
  `branch`, `dirty`. `/statusline` now validates against the shared
  `SEGMENT_NAMES` constant — adding a new segment is one switch case,
  not three edits across REPL + handler + help text.
- **`--quiet` + `/quiet` toggle.** Persisted `quiet: boolean` in
  preferences plus a `BRAINROUTER_QUIET=1` env override gate
  tool-start chrome, tool-success summaries, briefing / capture /
  citation memory events, file-mention attachment lines, and tool
  previews. Failures and memory contradictions still surface.
- **Theme module.**
  [`brainrouter-cli/src/cli/theme.ts`](brainrouter-cli/src/cli/theme.ts)
  with semantic tokens (primary, secondary, success, warning, danger,
  info, muted, dim, heading, plain) and three palettes (`dark` —
  original Midnight Ledger; `light` — darker accents for white
  terminals; `mono` — identity for screenshots and pipes). Selection:
  `BRAINROUTER_THEME` env > preference > `dark`. The readline prompt
  and the access-mode accent (read→success, write→primary,
  shell→danger) now consume theme tokens, so `light`/`mono` actually
  reach the surface the user stares at most. Remaining hard-coded
  `chalk.green`/`red` calls in tool-feedback chrome (✓/❌, plan marks,
  error messages) intentionally left for an incremental follow-up.
- **Idle help hint.** 30s after the prompt appears (or after each turn
  ends), if no input arrived and no continuation is running, the REPL
  prints one nudge: "Tip: press `?` or `/help` for commands, `/where`
  for current state." Fires once per session; bare `?` is now wired to
  `/help` so the tip actually works.
- **Node warning suppression — via a CJS bin shim.** The first attempt
  installed the warning filter at the top of `src/index.ts` and didn't
  work: ESM hoists every `import` (including `import 'node:sqlite'`
  transitively through `config/config.ts`) above any top-level code in
  the file, so the warning fires before the filter is registered. The
  fix is a tiny CJS entrypoint at
  [`brainrouter-cli/bin/cli.cjs`](brainrouter-cli/bin/cli.cjs) that
  installs a filtered `warning` listener and `process.emitWarning`
  override synchronously, THEN dynamic-imports the ESM CLI. `package.json`
  `bin` was repointed at the shim; `src/index.ts` keeps a defense-in-depth
  filter for `tsx`/dev runs that bypass the shim.

Also bundled (independent but small and already accounted for in
CHANGELOG): `/tokens` no longer sums every child ever spawned in the
workspace — child usage is now filtered by `parentSessionKey ===
agent.sessionKey`, and `/resume` / `/fork` zero the in-process parent
counters since the persisted transcript doesn't carry per-call usage.

**Out of scope for 0.3.6 (deferred):**

- A full TUI (split panes, scrollback regions, persistent sidebar).
  That's a 0.5.x candidate — would benefit from referencing
  [`antigravity-cli/`](openSrc/antigravity-cli/) for ergonomic patterns
  before committing.
- Mouse support / clickable links.
- Broader theme sweep across the remaining tool-feedback chrome in
  `repl.ts` (per the Tasks.md "consolidation is opt-in and can land
  incrementally" note). Tracked for a follow-up.

### 3. Multi-workflow concurrency

**State of play.** The storage layer already supports many workflows
on disk: every `/feature-dev`, `/spec`, `/review`, `/implement-plan`
creates a new `<workspace>/.brainrouter/workflows/<slug>/` folder with
its own `meta.json`, and `listWorkflows()` returns the full set
([`workflowArtifacts.ts:120`](brainrouter-cli/src/state/workflowArtifacts.ts:120)).
What's missing is the runtime UX to actually *work on more than one at
a time*:

- **`current-workflow.json` is a single pointer per workspace** and
  every `createWorkflow()` silently overwrites it; there's no command
  to switch back to a previously-active workflow without making a new
  one.
  ([`workflowArtifacts.ts:134`](brainrouter-cli/src/state/workflowArtifacts.ts:134))
- **Goal state is workspace-scoped** (see item 1 above) — the same
  `goal.json` is read across every workflow in the workspace. Even
  after the item-1 fix moves it to per-session, that's still not
  per-workflow.
- **`isProcessing` lock serializes turn execution per CLI process.**
  Even if multiple goals existed, only one continuation loop can run
  at a time inside a single REPL.
  ([`cli/repl.ts:249`](brainrouter-cli/src/cli/repl.ts:249))

**Scope for 0.3.6.**

- **`/workflow switch <slug>`** — refocus on an existing workflow.
  Updates the current pointer; loads the workflow's saved goal state
  into the session (see next bullet). Refuses if the source workflow's
  goal is `active` and would conflict with the target's `active`
  state — the user must pause/complete the source first.
- **Per-workflow goal binding.** Move goal persistence to
  `<workflow>/goal.json` so switching workflows carries the goal with
  it. When no workflow is bound (quick-task path), fall back to the
  session-scoped path from item 1. Migration: on a `/workflow switch`,
  the current session's goal is moved into the target workflow's
  folder.
- **`/workflows` upgrade.** Show per-workflow goal status alongside
  the spec/tasks/walkthrough markers, plus iteration budget usage.
  Makes the list a real switcher dashboard, not just a folder index.
- **`/workflow pause` + `/workflow resume <slug>`** — pause the
  current workflow's goal (already supported as `/goal pause`) and
  provide a one-shot resume-by-slug. The latter combines
  `/workflow switch` + `/goal resume`.
- **Explicit conflict surface on `createWorkflow()`.** When
  `/feature-dev` or `/spec` would clobber an in-progress workflow's
  current pointer, prompt before flipping — same UX shape as
  `GoalConflictError`. Users should never lose track of a workflow
  because they typed a new `/spec` while another was open.

**Out of scope for 0.3.6** (deferred to 0.4.0 federation or later):

- **Concurrent goal execution within one CLI process.** The
  `isProcessing` lock stays. Two parallel continuation loops in the
  same REPL would require a far bigger redesign (multiplexed turn
  queue, per-workflow LLM-semaphore slice, UI for "which workflow am
  I watching"). Easier to ship "multiple CLI windows, one per
  workflow" via the v0.4.0 federation plan below.
- **Cross-workflow handoff** — covered by Stage 4 of v0.4.0.

### 4. Mid-turn user-choice prompt (`ask_user_choice` local tool)

**State of play.** brainrouter-cli has `askYesNo`
([`cliPrompt.ts:33`](brainrouter-cli/src/cli/cliPrompt.ts:33)) for one-shot
yes/no questions and uses `inquirer` in
[`index.ts`](brainrouter-cli/src/index.ts) for the one-time
`brainrouter config` setup wizard — but there is **no multi-choice
mid-turn prompt** the agent can call to pause and present 2–4
mutually-exclusive options to the user before continuing.

The pattern this would enable (familiar from Claude Code's
`AskUserQuestion` tool, which we've been using throughout this session):
mid-task, when the agent reaches an inflection point where multiple
reasonable approaches exist, it pauses, presents the options with short
descriptions, the user picks one, and the agent continues with that
choice in context.

**Scope for 0.3.6.**

- **New local tool `ask_user_choice`** registered alongside `run_command`,
  `read_file`, `apply_patch`, etc. in
  [`brainrouter-cli/src/agent/agent.ts`](brainrouter-cli/src/agent/agent.ts).
  Signature:
  ```
  ask_user_choice({
    question: string,          // the question itself
    header: string,            // short chip-style label (≤12 chars)
    options: Array<{ label: string, description: string }>,  // 2–4 options
    multiSelect?: boolean      // default false
  }) → { answer: string | string[] }
  ```
- **TTY rendering.** Reuse the existing `activeReadline` bridge from
  [`cliPrompt.ts`](brainrouter-cli/src/cli/cliPrompt.ts) — pause the agent
  loop, print the question + numbered options + descriptions to stdout,
  await `rl.question` reply, validate the choice (allow option number OR
  partial label match), resume the loop. New helper: `askChoice(question,
  options, { multiSelect })` alongside `askYesNo`.
- **Non-TTY fallback.** When `stdin.isTTY` is false (CI, piped runs,
  headless `brainrouter run`), the tool returns a "no TTY" error so the
  agent can fall back to deciding itself. Mirrors how `askYesNo` returns
  the default on non-TTY but stricter — choice prompts shouldn't silently
  pick option 1 for the agent.
- **System-prompt nudge.** Update
  [`brainrouter-cli/src/prompt/systemPrompt.ts`](brainrouter-cli/src/prompt/systemPrompt.ts)
  with a short rule on when to call `ask_user_choice` vs. just deciding
  unilaterally — "use when there's genuine ambiguity with 2–4 mutually
  exclusive reasonable approaches; do NOT use for trivial confirmations
  (`askYesNo` covers those), things you can decide yourself with the
  available context, or as a substitute for thinking."
- **Tests.** Mock the readline interface, fake `rl.question` replies,
  verify the tool returns the chosen option, validates out-of-range
  answers, and surfaces the no-TTY error path. Add to
  [`brainrouter-cli/src/agent.test.ts`](brainrouter-cli/src/agent.test.ts).

**Out of scope for 0.3.6.**

- Surfacing the prompt in non-CLI surfaces (dashboard chat, HTTP MCP
  clients). The local-tool design keeps this CLI-only; remote clients
  attached to the same MCP wouldn't see it. Federation Stage 3 (v0.4.0)
  is where cross-process user prompts would land if we want them.

### 5. Structured reasoning-step capture in working memory

**State of play.** BrainRouter's working memory ([`brainrouter/src/memory/working/`](brainrouter/src/memory/working/)) is fully wired and the `WorkingStep.kind` field is free-form, so the primitive for capturing reasoning steps already exists. What's missing is the **discipline / guidance** for the agent to actually emit them.

Today's behaviour, audited end-to-end:

| Category | Captured? | Where |
|---|---|---|
| Current Plan | ✅ | [`taskStore.ts`](brainrouter-cli/src/state/taskStore.ts) → `<session>/tasks.json` |
| Tool Outputs | ⚠️ opt-in | Working memory `steps.jsonl` IF the agent calls `memory_working_offload` (default `kind="tool_output"`) |
| Sub Tasks | ⚠️ flat only | Plan items; no nesting |
| **Reasoning Steps** | ❌ | **Nowhere durable** — lives only as prose inside assistant messages in the transcript |

Reasoning is the gap. The system prompt at
[`brainrouter-cli/src/prompt/systemPrompt.ts:25`](brainrouter-cli/src/prompt/systemPrompt.ts:25)
already says "walk through your reasoning before tool calls when the
task is non-trivial," but that reasoning evaporates into chat-content
prose — the next turn's briefing has the recall block and the working
canvas, but nothing structured about *why* the agent did what it did
in the previous batch. After a long session, `/working` shows the
offloaded tool payloads but no reasoning trail.

**Scope for 0.3.6.**

- **System-prompt rule.** Update
  [`brainrouter-cli/src/prompt/systemPrompt.ts`](brainrouter-cli/src/prompt/systemPrompt.ts)
  with a new line: "After every non-trivial tool batch (≥3 tool calls
  OR any tool that produced >2KB of output), call
  `memory_working_offload` once with `kind: \"reasoning\"`, `title:
  \"Why: <short>\"`, and a 1-paragraph summary of the *decision* you
  made and *why* (not what the tools returned)." Pairs with the
  existing >1000-token offload rule, which covers payloads but not
  decisions.
- **Canvas + state.json updates.** The working-memory canvas
  ([`brainrouter/src/memory/working/canvas.ts`](brainrouter/src/memory/working/canvas.ts))
  already renders steps by `kind` in the Mermaid tree. Confirm that
  `kind: "reasoning"` gets a distinct node style (e.g. dashed border)
  so reasoning steps are visually separable from tool outputs and
  compressed summaries.
- **Briefing surface.** When `memory_working_context` is pulled into
  the next turn's briefing
  ([`brainrouter-cli/src/memory/briefing.ts:50`](brainrouter-cli/src/memory/briefing.ts:50)),
  ensure reasoning-kind steps surface in the recentSteps tail (not just
  the most recent tool outputs). Possibly cap at the last 3 reasoning
  steps to avoid stuffing the briefing.
- **Tests.** Add a `kind: "reasoning"` round-trip test in the
  working-memory suite ([`brainrouter/src/__tests__/working-memory.test.ts`](brainrouter/src/__tests__/working-memory.test.ts)).
  Also a CLI-side check that the system-prompt change actually surfaces
  in the assembled prompt.

**Out of scope for 0.3.6.**

- **Auto-capture of reasoning** (CLI intercepts and writes the
  reasoning step itself without LLM call). Different tradeoff — would
  require parsing assistant content for a reasoning-block convention,
  more brittle. Defer to v0.4.x.
- **Auto-offload of large tool outputs** under token pressure. Related
  but distinct — see the "auto-offload-under-pressure" discussion
  notes; skipped from this release on user direction.

### Recommended build order

```
  1.  Goal-leakage fix      (item 1)  ✅ shipped — PR #26
  2.  CLI shell redesign    (item 2)  ✅ shipped — PR #27
  2b. ask_user_choice tool  (item 4)  — small, independent, CLI UX. Banner
                                        + statusline (item 2) already there
                                        so prompts render against a
                                        consistent themed shell.
  2c. Reasoning-step capture(item 5)  — system-prompt + tiny canvas /
                                        briefing tweaks; complements item 2's
                                        "what's the agent doing right now"
                                        status line by surfacing the *why*.
  3.  Multi-workflow        (item 3)  — depends on item 1 (correct goal
                                        scoping primitive); displays via
                                        item 2's new `workflow` + `goal`
                                        statusline segments.
```

Why the ordering held:

- **Item 1 first** because it was a bug the user was hitting *now*. Per-workflow
  goal binding in item 3 builds on the corrected primitive — shipping item 3
  on top of the broken legacy fallback would have inherited the cross-session
  leak.
- **Item 2 second** because it's mostly orthogonal to the goal/workflow data
  model — the status line just *reads* whatever's authoritative. Doing it
  second means item 3's eventual `/workflow switch` lights up the new
  `workflow` statusline segment immediately, no extra wiring.
- **Item 3 last** because it touches the most surfaces (storage, commands,
  status line, conflict prompts) and benefits most from items 1 + 2 being
  in place. Also the largest reviewable-PR surface — easier to land in one
  focused pass once the ground is settled.

---

## Current Status & Verification

- **Manual Verification**: Run the late-phase integration test scenarios against a live MCP HTTP server and dev server.
- **Security Check**: Evaluate whether to migrate the custom IP-based rate limiter in `brainrouter/src/index.ts` to `express-rate-limit` depending on production deployment security requirements.

---

## Up Next

- **Docker image for the MCP server**: One-command `docker run` deploy so users don't have to manage Node/SQLite/embedding-dimension drift themselves.
- **Dashboard memory explorer**: Surface FTS/vector ranking signals + `memory_explain_recall` inline so users can audit *why* a record surfaced.
- **Dashboard parity with CLI**: Match goal lifecycle, hookify rules, and multi-agent orchestration in the browser surface (`brainrouter-dashboard`).
- **Provider matrix**: Verified configs for OpenAI, Anthropic, Gemini, OpenRouter, and local backends (LM Studio, Ollama).
- **`@kinqs/brainrouter-sdk` 1.0**: Lock the public surface so external integrators can build against it without expecting renames.

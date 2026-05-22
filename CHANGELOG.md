# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2026-05-22

### Added — `/goal` state machine
- **`usage_limited` status.** New resumable state distinct from `paused` (user-initiated) and `blocked` (agent gave up). Used when the iteration OR token cap runs out; the user can raise the cap and `/goal resume`. ([state/goalStore.ts](brainrouter/src/state/goalStore.ts))
- **Token budget alongside iteration budget.** Optional `maxTokens` cap on the goal that tallies prompt + completion tokens per turn. When the cap is reached, the goal transitions to `usage_limited` instead of consuming another iteration. Lets users protect a fixed dollar budget without estimating turn counts. ([state/goalStore.ts](brainrouter/src/state/goalStore.ts), [cli/repl.ts](brainrouter/src/cli/repl.ts))
- **Replace-confirmation prompt.** `/goal <new text>` now refuses to silently overwrite an `active`, `paused`, `blocked`, or `usage_limited` goal — the REPL surfaces a `y/N` confirmation citing the existing objective and iteration progress. Replacing a `complete` goal is allowed silently (the prior work is done, starting fresh isn't a risk). ([state/goalStore.ts](brainrouter/src/state/goalStore.ts) — new `GoalConflictError`)
- **Wrap-up steering on the final budget turn.** When the next continuation would be the last turn before the iteration cap (or 80% of the token cap), the loop injects a hidden directive telling the model to consolidate, call `goal_complete` with evidence, or call `goal_blocked` with a specific unblocker — instead of starting new investigations that won't finish. ([state/goalStore.ts](brainrouter/src/state/goalStore.ts) — `buildBudgetSteeringMessage`)
- **Resume-paused-goal prompt on `/resume`.** When `/resume <session>` loads a session whose goal is `paused`, `blocked`, or `usage_limited`, the REPL prompts whether to resume the goal now. Eliminates the "loop silently stays paused" footgun. ([cli/repl.ts](brainrouter/src/cli/repl.ts))
- **`/goal edit <field> <value>`** — unified update entrypoint for status / text / budget / tokens. Replaces stringing pause→budget→resume by hand. Fields: `text`, `status`, `budget`, `tokens`. ([cli/repl.ts](brainrouter/src/cli/repl.ts), [state/goalStore.ts](brainrouter/src/state/goalStore.ts) — `editGoal`)
- **`/goal tokens <N>`** — set or clear the per-goal token cap (0 to clear). ([cli/repl.ts](brainrouter/src/cli/repl.ts))

### Changed — `/goal`
- Goal continuation now transitions to `usage_limited` (with a reason string) when the iteration cap is exhausted, instead of remaining `active` with `goalHasBudgetLeft === false`. Gives the UI and `/goal` status output a single consistent resumable state regardless of which cap tripped.
- `formatGoalBlock` shows token usage alongside iteration usage when a token cap is set.

### Refactored (structural only — no runtime behavior change)

Three structural refactors landed together; every slash command, every CLI flag, and every code path behaves identically before and after. The only changes are where files live, what they're named, and how the dispatcher routes to them.

- **`repl.ts` split into category command files.** The 2879-line monolith with all 86 slash-command handlers in one giant switch was reduced to a 1011-line REPL shell (–65%). Handlers live in seven category files under `cli/commands/`: `memory.ts` (18 cmds), `ui.ts` (22), `workflow.ts` (15), `orchestration.ts` (9), `obs.ts` (6), `guard.ts` (6), `session.ts` (10). Plus two helper modules: `_context.ts` (shared `CommandContext` type) and `_helpers.ts` (cross-cutting `printMcpCall`, `printMemoryCards`, `buildGoalKickoffPrompt`, `runSkillCommand`, etc.). Dispatch is a 7-line walk through `tryHandleX(ctx)` calls; first match wins. Adding a new slash command no longer requires touching `repl.ts` — pick a category file and add a `case`. Tests still passing; every command does exactly what it did before.
- **Source tree restructured into responsibility folders.** All 32 source modules under `brainrouter/src/` were moved out of the flat root into 8 semantic subdirectories: `agent/`, `cli/`, `config/`, `memory/`, `orchestration/`, `prompt/`, `runtime/`, `state/`. `index.ts`, `agent.test.ts`, and `types.d.ts` stay at the root. Five modules picked up shorter names now that the folder gives the context — `memoryBriefing.ts → memory/briefing.ts`, `memoryFormatters.ts → memory/formatters.ts`, `memoryConsolidation.ts → memory/consolidation.ts`, `orchestratorTools.ts → orchestration/tools.ts`, `agentRoles.ts → orchestration/roles.ts`. All 125 intra-src import sites were rewritten in lockstep. Used `git mv` throughout so blame history is preserved on every file.
- README's repository-structure section refreshed to mirror the new tree with one-line summaries per module.
- **Version bumped to 0.3.3 across the monorepo.** All seven `package.json` files (root, `brainrouter`, `mcp`, `web`, `packages/types`, `packages/sdk`, `packages/hooks`) plus the four hardcoded version strings in source (`commander --version`, MCP client metadata, MCP server metadata, two `User-Agent` strings) were synced. Prior releases had drifted: root was at `0.1.0` while sub-packages were at `0.2.0`, and the 0.3.0 / 0.3.1 / 0.3.2 CHANGELOG entries shipped without corresponding `version` bumps. This release closes that gap.

### Fixed
- **`/feedback` no longer writes inside the workspace.** Path moved from `<workspace>/.brainrouter/cli/feedback.jsonl` (which risked accidental commits and contradicted the "personal CLI state lives under `~/.brainrouter/`" guarantee) to `~/.brainrouter/workspaces/<encoded>/cli/feedback.jsonl` via `getCliStateFile()`.
- **`/hookify` help text now points at the real location.** Previously said `.brainrouter/hooks/` (legacy in-workspace path); now correctly references `~/.brainrouter/workspaces/<encoded>/hooks/` and explains that legacy in-workspace files auto-migrate on first read.

### Tests
- 95 passing (up from 89). New coverage: `GoalConflictError` shield + bypass with `force`, status-aware error message, token budget tally + `goalIsOnFinalBudgetTurn` heuristic, `editGoal` unified mutation, empty-text edit refusal, `buildBudgetSteeringMessage` per-trigger wording, `removeTaggedSystemMessage` idempotency.

### Review-driven follow-ups (applied this release)
- **Stale budget-steering messages cleared on budget extension.** When the user raises the iteration or token cap (via `/goal budget`, `/goal tokens`, `/goal edit`, `/goal resume`, or the resume prompt after `/resume`), any prior "this is your last turn" steering message is dropped from chat history. Without this, the directive would persist and tell the model to wrap up even after it gained more headroom. The post-turn continuation also now removes the steering when the next turn would NOT be on a final budget.
- **`removeTaggedSystemMessage(tag)`** added to the Agent — companion to `replaceTaggedSystemMessage`. Lets the REPL retract one-off directives once their motivating condition no longer holds. Idempotent.
- **`GoalConflictError` message reports the actual existing status.** Previously hardcoded "already active" even when the existing goal was `paused`, `blocked`, or `usage_limited`, which surfaced verbatim to users via the REPL catch path. Now reads "A goal already is in progress" for active goals and "A goal already exists with status: paused/blocked/usage limited" otherwise.
- **`buildBudgetSteeringMessage` differentiates iteration-tight vs token-tight triggers.** Previously always claimed "one turn left within the iteration budget" even when only the token-cap heuristic (80% used) tripped — misleading on token-budgeted runs with plenty of iterations remaining. The message now describes whichever cap is actually tight (iteration, token, or both) with the real remaining counts.

## [0.3.2] - 2026-05-22

### Added (Claude Code 2.1.147 parity)
- **OTEL trace parent-child nesting for spawned agents.** Child agents now inherit `parentTraceId` + `parentSpanId` from the dispatching `spawn_agent` tool span so observability viewers can reconstruct fan-out trees. Each Agent instance gets a stable `agent.agentId` and tool events are tagged with `parent_agent_id`. Matches Claude Code 2.1.147's `agent_id` / `parent_agent_id` OTEL attributes. ([agent.ts](brainrouter/src/agent.ts), [orchestratorTools.ts](brainrouter/src/orchestratorTools.ts))
- **Headless mode rejects slash commands with a clear error.** `brainrouter run "/help"` no longer silently routes the slash command to the LLM — now exits with code 2 and tells you to use the interactive REPL. ([index.ts](brainrouter/src/index.ts))
- **GitHub PR info in statusline.** New `pr` segment (`/statusline mode,branch,pr`) detects the current PR via `gh pr view` with a 30s cache. ([repl.ts](brainrouter/src/repl.ts))
- **Dynamic terminal tab title with awaiting-input count.** When a goal continuation is pending OR any child agent is in `running`/`pending` state, the tab title gets prefixed with `(N) ` so background tabs surface attention without focus. ([repl.ts](brainrouter/src/repl.ts))
- **`brainrouter agents [--json]`** — list child sessions from the command line without entering the REPL. Mirrors `claude agents --json` for tmux-resurrect, status bars, and agent pickers. ([index.ts](brainrouter/src/index.ts))
- **In-REPL `/agents --json`** — same payload as the CLI command for shell-pipe scripting from inside the REPL.
- **Paginated `/help`** with category groups (`session`, `memory`, `workflow`, `orchestration`, `guard`, `obs`, `ui`). On small terminals shows an index; on tall ones shows everything. `/help <category>` drills in. Replaces the 95-line `console.log` block. ([repl.ts](brainrouter/src/repl.ts))
- **Streaming diff for large edits.** `/diff` now spawns `git diff --color=always` with `stdio: inherit` so output appears immediately. Adds `--staged` and `--all` flags. ([repl.ts](brainrouter/src/repl.ts))

### Fixed
- **Slash commands followed by tab/newline now match correctly.** `input.split(' ')` → `input.trim().split(/\s+/)` so `/help\t` and `/help\n` no longer fall through to "Unknown slash command". ([repl.ts](brainrouter/src/repl.ts))
- **Prompt history no longer records consecutive duplicate user prompts.** Arrow-up + Enter to replay the same prompt no longer adds another copy to the transcript. ([sessionStore.ts](brainrouter/src/sessionStore.ts))

### Tests
- 89 passing (up from 87). Added: prompt-dedup regression, OTEL span shape via existing trace tests.

## [0.3.1] - 2026-05-22

### Fixed
- **🚨 Recall key typo (silent memory failure).** The CLI looked for `recalledCognitiveRecords` but the MCP emits `recalledCognitiveMemories`. Every briefing returned 0 records, `memory_mark_cited` never ran, the LTP/decay loop was effectively dead. Fixed at all four call sites — [`memoryBriefing.ts:142`](brainrouter/src/memoryBriefing.ts), [`memoryFormatters.ts:48`](brainrouter/src/memoryFormatters.ts), [`memory_mark_cited.ts:30`](mcp/src/tools/memory_mark_cited.ts), [`chat-completions.ts:147`](mcp/src/api/routes/chat-completions.ts).
- **MCP child never saw LLM credentials.** `mcp/.env` is loaded by the MCP via `dotenv/config`, which resolves relative to the child's `cwd` — when spawned by the CLI that was the user's launch directory, not `mcp/`. Symptoms: 79 consecutive extraction failures, sensory rows piled up, cognitive table stayed empty. Fixed by adding a tiny `.env` loader at CLI startup ([`brainrouter/src/index.ts`](brainrouter/src/index.ts)) AND setting the spawned MCP child's `cwd` to the MCP package directory so `dotenv/config` finds the file ([`mcpClient.ts`](brainrouter/src/mcpClient.ts)).
- **`OPENAI_API_KEY` fallback bypassed by empty config string.** [`config.ts`](brainrouter/src/config.ts) shipped `llm.apiKey: ''`; the env propagation used `??` (nullish) so the empty string beat the env-var fallback. Switched to truthy checks with a `(llmConfig.apiKey || OPENAI_API_KEY || BRAINROUTER_LLM_API_KEY)` chain, plus a load-time backfill in `loadConfig()`.
- **Capture diagnostic was misleading.** The CLI printed `💾 Captured` even when extraction silently failed; a later "extractor ran but produced 0 records" warning then fired for trivial exchanges (greetings) where the LLM correctly returned an empty list. Added `cognitiveExtractionStatus: 'ok' | 'failed' | 'skipped'` to [`CaptureResult`](packages/types/src/memory.ts) and routed it through [`agent.ts`](brainrouter/src/agent.ts) + [`repl.ts`](brainrouter/src/repl.ts). Warning now only fires on real failures and carries the actual error message.
- **`captureTurn` skipped on loop-limit and empty-answer turns.** Memory + citation feedback were lost on every aborted turn. Moved the loop-limit / empty-answer normalization above the captureTurn call so all exit paths feed a non-empty final answer to memory.
- **`/verify` field name mismatch.** [`repl.ts`](brainrouter/src/repl.ts) sent `status` but the MCP tool requires `verificationStatus`. Failed 100% of the time. One-word fix.
- **Goal budget off-by-one.** Budget=10 fired 11 iterations. [`goalStore.ts`](brainrouter/src/goalStore.ts) `goalHasBudgetLeft` now checks `iterationsUsed + 1 < maxIterations`.
- **Silent verifier children bypassed shell approval.** `spawn_agent({role:'verifier'})` ran with `silent: true` AND `accessMode: 'shell'`; the `run_command` approval prompt was gated on `!this.silent`, so silent children skipped it entirely. Now silent children refuse shell unless `prefs.autoApproveShell` is set. Closed the privilege-escalation path where a `read`-mode parent could spawn a `shell`-mode child via the [`clampAccess`](brainrouter/src/orchestratorTools.ts) helper.
- **`/side` and `/btw` sessionKey race.** Restored parent session via `setTimeout(100ms)` — turns take seconds, so side-conversation tool calls and replies were appended to the MAIN transcript. Replaced with a proper `runAgentTurnAsync().finally(restore)` pattern.
- **Two parallel turn pipelines collapsed.** `/commit`, `/spawn`, `/wait`, `/kill`, `/approve`, `/feature-dev`, `/spec`, `/review`, `/implement-plan`, `/skill` used to route through a second-class `runOrchestrationPrompt` without goal continuation, `isProcessing` lock, `/raw` honoring, contradiction surfacing, or token summary. All now go through `ctx.runAgentTurn` and inherit the full polish.
- **Briefing & fan-out-hint stacked across turns.** Each turn pushed a fresh system message; 10 turns = 10 stacked briefings, linear token bloat. New `replaceTaggedSystemMessage` helper replaces the prior copy; marker comments are stripped before the payload reaches the LLM.
- **Briefing rendered as raw JSON dump, often sliced mid-payload at 4KB.** Replaced with structured cards (`[recordId] (type) one-line preview`) and skipped empty-recall sections entirely.
- **JSON state corruption killed the REPL.** [`readJsonFile`](brainrouter/src/cliState.ts) rethrew on parse error; a half-written `goal.json` could brick boot. Now quarantines the bad file to `<path>.corrupt-<ts>` and returns the fallback.
- **JSONL transcript corruption killed `/resume`.** [`readTranscriptEntries`](brainrouter/src/sessionStore.ts) `JSON.parse` had no try/catch. Now skips bad lines with a one-line warning instead of crashing.
- **`writeJsonFile` temp-suffix collision.** Two writes in the same millisecond used identical `${pid}.${Date.now()}.tmp` and could lose data on `rename`. Added a 6-byte random nonce.
- **Tool results never truncated before re-entering history.** A long-running session pushed 50–70KB MCP payloads back to the LLM every turn forever. Now clamped at 8KB for the LLM-visible copy (full text still recorded in transcript). Configurable via `BRAINROUTER_MAX_TOOL_RESULT_CHARS`.
- **No MCP timeout.** A hung MCP server hung the whole turn forever. Now races against `BRAINROUTER_MCP_TIMEOUT_MS` (default 60s).
- **No auto-compaction trigger.** `/compact` was manual-only; long sessions silently blew the request body cap. Now auto-compacts at `BRAINROUTER_AUTO_COMPACT_TOKENS` (default 80k).
- **Hallucinated tool names hard-failed.** `Read_File` / `read-file` / `read.file` returned `-32601 Unknown tool` and wasted a loop iteration. New `normalizeToolName()` does fuzzy match against the live tool registry first.
- **Malformed JSON tool arguments silently coerced to `{}`.** Now surfaces the parse error back to the LLM as an explicit failure so it can self-correct.
- **Sweeper interval misconfiguration could flood the LLM backend.** `mcp/.env` line read `BRAINROUTER_EXTRACTION_SWEEP_INTERVAL_MS=100` — 100ms not 100s, so the sweeper fired 10× per second and overwhelmed LM Studio. Added a 30s code-level floor with a warning log, plus a reentrancy guard so overlapping ticks become no-ops.

### Added
- **LLM concurrency semaphore (both sides).** [`mcp/src/memory/llm-semaphore.ts`](mcp/src/memory/llm-semaphore.ts) caps simultaneous LLM calls from the MCP child (default 2: cognitive extraction, contradiction check, graph extraction, focus-shift detection, sweeper, embeddings). [`brainrouter/src/llmSemaphore.ts`](brainrouter/src/llmSemaphore.ts) caps simultaneous chat LLM calls from the CLI process (default 4 — bursts well for fan-out, queues background pressure). Both honor `BRAINROUTER_LLM_MAX_CONCURRENT`. On consumer hardware running LM Studio set it to `1`; on cloud backends crank to `16+`.
- **LM Studio "Model is unloaded" auto-recovery.** Detects the specific 400 body and retries once after 1.5s — LM Studio's JIT load usually has the model ready by then. Falls through to a user-readable error pointing at LM Studio's JIT toggle if the retry also fails.
- **Universal "Headline-first" rule for spawned children.** Every role overlay now requires the child to open with a `## Headline` block; [`extractChildPreview`](brainrouter/src/orchestratorTools.ts) parses that section as the parent-visible preview instead of `slice(0, 800)`. Falls back to head+tail so the conclusion at the bottom of long reports isn't dropped.
- **Spawn agent visual.** `🛞 Calling tool: spawn_agent({...})` (JSON dump) replaced with Claude-Code-style `🤖 Spawning agent: explorer [label] — <one-line task>`. `spawn_agents` (batch) prints `🤖 Spawning 5 agents in parallel: explorer, explorer, explorer, ...`.
- **Stronger fan-out detection.** Lowered threshold 1.8 → 1.5; added `verb-object-broad` (matches "test all", "review every", "audit the whole codebase"), `emphatic-every`, `verification-blanket`, `distributive` patterns. The prompt "manually review our brainrouter cli for everything every single line" now scores 6.0 (was 1.5).
- **HTTP MCP transport, end-to-end.** Already wired in code; documented + verified locally. Switch via `~/.config/brainrouter/config.json` → `"activeServer": "local-http"`. Backend logs now stay in the MCP terminal; CLI window shows only conversation output.
- **`/doctor` extraction health check.** Reports `healthy | backlog | DEGRADED` and surfaces the last extractor error message inline, with a hint when no LLM key reached the child.
- **`activeSkill` plumbed end-to-end** through `Agent`, `injectRecallContext`, `captureTurn`. Skill-scoped recall boost, neural-spark prewarming, and per-record `skill_tag` extraction all fire correctly now.
- **`memory_explain_recall` output readability.** Ranked Results now show `[type] score · shortId` with the matching content snippet inline, instead of a wall of opaque record IDs.

### Tests
- 87 passing, up from 80. New coverage: canonical recall key extraction, `clampAccess` security clamp, `normalizeToolName` fuzzy match, breadth-hint trigger calibration, child preview headline extraction, LLM semaphore queueing, goal text length cap.

## [0.3.0] - 2026-05-22

### Added
- **Terminal Agent CLI (`brainrouter`)**: Memory-native coding agent built on the BrainRouter cognitive stack. Ships ~70 slash commands (`/spawn`, `/agent`, `/wait`, `/route_agent`, `/memory`, `/recall`, `/briefing`, `/scenes`, `/feature-dev`, `/spec`, `/review`, `/implement-plan`, `/hookify`, `/loop`, `/compact`, `/personas`, `/skills`, …), an LLM-driven compactor, and durable per-session transcripts under `~/.brainrouter/workspaces/`.
- **Multi-Agent Orchestration**: First-class `spawn_agent`, `list_agents`, `wait_agent`, `read_agent_transcript`, and `route_agent` tools. Five built-in roles — **explorer** (read-only research), **architect** (design tradeoffs), **reviewer** (severity-ordered findings), **worker** (write-access implementation), **verifier** (test/shell validation) — each with mandatory memory-first workflows. Child outputs above 6k chars auto-offload to a working-memory canvas instead of polluting parent context.
- **Web Chat (`/chat`)**: Interactive in-browser agent chat with full memory engine access — recall, scenes, consolidation, and contradictions all surface during the conversation.
- **HTTP Chat Completions Endpoint**: MCP server now exposes a `/api/chat-completions` route so any HTTP client can drive BrainRouter agents while inheriting the cognitive memory stack.
- **Memory Consolidation (Phase 2)**: New `memory_consolidate` MCP tool and `/memories consolidate` CLI command produce human-readable filesystem snapshots (`MEMORY.md`, `user.md`, `feedback.md`, `project.md`, `reference.md`, `raw_memories.md`, `rollout_summaries/`) at `.brainrouter/memories/`.
- **Filtered & Freshness-Boosted Recall**: `memory_recall` / `memory_search` accept `filters` (types, scenes, time window, `minPriority`, `skillTag`) and rank brand-new captures with a freshness bump.
- **Graph Expansion & Spreading Activation**: 2-hop BFS over the knowledge graph, citation-driven LTP (+5% per cite, capped at +30%), and synaptic pruning (uncited ≥10 → archive).
- **Hookify Markdown Rules**: Drop a `.md` file with YAML frontmatter into `.brainrouter/hooks/` to install warn/block guardrails on tool calls — no code required.
- **Working-Memory Canvas**: `memory_working_*` tools manage the active context canvas where large child-agent outputs land for the parent to inspect on demand.
- **Memory Governance & Engineering Tools**: `memory_governance_*` (audit, import/export, prune), `memory_engineering_*` (manual edits), and `memory_explain_recall` for ranking introspection.
- **Skill Memetic Potential & Pre-Warming**: `memory_register_skill_hints` + SNN-inspired heat model spikes skill charge on trigger keywords, decays with a 10-minute half-life, and injects critical skill context proactively.

### Changed
- README rewritten around the unified CLI + MCP + Web triple, with an explicit multi-agent role table and updated MCP tool inventory.
- Web home and about pages refreshed to reflect the CLI, multi-agent orchestration, and the broader memory engineering surface.

## [0.2.0] - 2026-05-21

### Added
- **Admin Users Console**: Fully interactive user dashboard at `/users` featuring paginated listings, user creation (via modal), status toggling (enable/disable), API key resets, and deletion with confirmation. Built-in self-protection prevents admins from deleting or disabling their own accounts.
- **Enhanced Memories Hub**: Completely redesigned memories page with a debounced text search, filter chips for classification types (instruction, codebase fact, etc.), status filter toggles (active/archived), inline editing modal, infinite scroll pagination, and checkbox-based bulk actions for administrator pruning/archiving.
- **Expanded Profile Settings**: Added profile display-name editing, masked API key display with quick-copy, rotate API key confirmation flow, and dynamically generated JSON config snippets for copy-pasting to MCP clients (STDIO and HTTP/SSE options).
- **Contradiction Resolution & Badge Count**: Wired up contradiction status filtering ("Open", "Resolved", "All"), visual arbitration controls (resolve/dismiss), and added a real-time pending contradiction badge in the Sidebar navigation.
- **Evidence Management Controls**: Restyled evidence page action triggers to match the theme design system with full kind-based filtering.
- **Theme & Layout Enhancements**: Added an animated golden loading spinner for page-load states, styling rules for premium markdown content, and improved visual styles for UI cards.
- **MCP Onboarding Banner**: Created a dismissible "Connect your MCP client" dashboard banner that displays localized SSE connection variables.
- **Secure Authentication & Guard**: Implemented "Remember Me" session persistence (saving JWT to local storage on select) and added client-side signup password strength validation.
- **Backend Infrastructure Hardening**:
  - Added built-in auth route rate limiting (20 attempts / 15 minutes per IP).
  - Dynamic CORS configuration with `BRAINROUTER_CORS_ORIGIN` env support.
  - Length constraint validation on signup inputs and memory updates.
  - SDK-level `BrainRouterApiError` class for returning descriptive error payloads.

### Fixed
- Fixed Recall Inspector crash on null or undefined potential score rendering.
- Fixed `AuthGuard` loading flash when validating session persistence on initial mount.
- Fixed stale JWT persistence by clearing invalid auth tokens after protected API call failures.

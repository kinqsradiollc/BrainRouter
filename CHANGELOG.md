# Changelog

All notable changes to BrainRouter.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

The full per-version history lives in [`brainrouter-changelog/`](brainrouter-changelog/) — one file per release. The current in-flight version (`[Unreleased]`) and the most-recent shipped release are inlined below for at-a-glance scanning; everything older is one click away.

---

## [0.3.7] - Unreleased

In-terminal configuration wizard + redesigned `/config` settings panel.
The CLI now feels like Claude Code / Codex / Grok-CLI / DeepSeek-TUI for
first-run onboarding — picker-driven, no JSON editing, no separate
`brainrouter login` / `brainrouter config` subcommand dance.

### Features

- **First-run wizard inside the REPL.** Launching `brainrouter` against
  a fresh `$HOME` (no `~/.config/brainrouter/config.json` or no
  `.onboarded` marker) drops the user into a 6-step picker flow
  (`Welcome → Theme → Provider → API key → Model → MCP → AGENT.md →
  Done`) instead of exiting with the pre-0.3.7 "No BrainRouter config
  found — run `brainrouter login`" error. Theme step live-previews the
  prompt accent on cursor moves. Provider step pre-detects which row
  is most likely to "just work" from shell env (`OPENAI_API_KEY`,
  `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`). API-key
  step pre-fills from the env var and uses a `validateApiKey` tier
  (`Accept{warning?}` / `Reject(reason)`) — unknown prefixes save with
  a non-blocking advisory rather than being rejected, because every
  vendor invents new key shapes. MCP step probes the user's pick (5s
  timeout) and offers "save anyway / try a different transport / skip"
  on failure. Aborting at any step (`q` / Ctrl+C) writes nothing —
  the draft is held in memory until the Done step commits.
  Implementation: [`brainrouter-cli/src/cli/wizard/`](brainrouter-cli/src/cli/wizard/).
  Patterns lifted from
  `openSrc/codex/codex-rs/tui/src/onboarding/onboarding_screen.rs`
  (Step state machine + ApiKeyInputState),
  `openSrc/DeepSeek-TUI/crates/tui/src/tui/onboarding/mod.rs`
  (onboarded marker + validation tier),
  `openSrc/grok-cli/src/ui/app.tsx:644` (render-time modal IS the
  onboarding).
- **`/init`** is now the wizard re-entry point. Same steps, same
  picker, but reuses the REPL's existing readline so users don't have
  to exit. Old "just scaffold AGENT.md" behaviour is preserved
  behind `/init agentmd` for back-compat.
- **`/config` settings home panel.** Bare `/config` opens an arrow-key
  picker over every CLI knob (LLM provider, MCP profile, theme,
  statusline, effort, mode, review policy, quiet, personality, editor)
  with the current value shown on the right. Selecting a row opens
  its sub-picker; Esc backs out. The pre-0.3.7 scrubbed-JSON dump
  lives under `/config raw`.
- **`/config` is verb-overloaded.** `/config theme` prints the
  current value; `/config theme dark` sets and persists.
  Known keys: `theme`, `statusline`, `effort`, `mode`,
  `review-policy`, `quiet`, `personality`, `editor`, `model`,
  `provider`. Unknown keys point at the bare picker.
- **`/login` slash command.** In-REPL alternative to `brainrouter
  login` — transport picker (stdio / local-http / remote-http) →
  field entry → 5s reachability probe → save. Failure offers the
  same "save anyway / try a different transport / cancel" fallback
  as the wizard. The legacy `brainrouter login` subcommand still
  works for users who scripted it.

### Improvements

- **Picker primitive extensions** (`brainrouter-cli/src/cli/cliPrompt.ts`).
  `askChoice` gains `onCursorChange(index)` (live-preview hook for
  theme picker; lifted from `openSrc/codex/codex-rs/tui/src/bottom_pane/list_selection_view.rs`),
  `prefilledOther` (drops the picker straight into the free-text
  "Other" mode with an env-derived default — ENTER accepts, edit
  overrides), and `initialCursor` (lets the settings panel re-open on
  the row the user just left). All three are additive — existing
  callers continue working with `undefined`.
- **`maskApiKey` helper** keeps the last 4 chars visible everywhere
  the key is rendered (`/config` panel, wizard Done summary, future
  `/where` workspace block).

### Docs

- **`brainrouter-docs/cli.md`** gains a new "First-run wizard (0.3.7+)"
  section + `/config` panel docs + `/login` row in the UI table.
- **`brainrouter-docs/configuration.md`** leads with a new
  "Quick start — interactive (recommended)" section. The env-var
  matrices stay below for CI / multi-tenant / split-provider users
  who genuinely need them.
- **`SETUP.md`** §2A collapses the `brainrouter login` + `brainrouter
  config` block to "run `brainrouter`; the wizard takes over."
- **`README.md`** First-time setup mentions `/init` + `/config` as
  the primary in-session knobs; legacy subcommands kept as a
  back-compat footnote.
- **`docs/specs/0.3.7-terminal-ui-redesign.md`** — full spec for the
  redesign (objective, non-goals, slash surface, wizard state
  machine, settings panel layout, persistence contract, DoD).
- **`brainrouter-roadmap/0.3.7.md`** — Item 6 added as the cycle
  headline. Items 1–5 (quick wins) follow.

### Tests

- **26 new tests** across `wizard.test.ts` + `config-command.test.ts`
  covering: `STEP_ORDER` invariants, `reduceWizard` advance / back /
  abort / warn / commit transitions, provider catalog shape, env-based
  provider detection precedence, API-key validation tier (accept /
  reject / warn-not-block), masking, picker `prefilledOther` +
  `initialCursor` semantics, and `/config` argument-parsing routing
  (home / raw / get / set / trimmed values). Full suite: brainrouter
  262/262 + brainrouter-cli 238/238 = 500 green.

---

## [0.3.6] - Unreleased

Smarter memory recall, friendlier dashboard, more reliable agent loop.

### Features
- **Multi-workflow concurrency.** You can now keep multiple workflows in flight in the same workspace and move between them like git branches. The storage layer already created a folder per `/feature-dev` / `/spec` / `/review` / `/implement-plan` invocation; what was missing was the runtime UX. Six surfaces now make the switcher real:

  - **Per-workflow goal binding via `resolveGoalScope`.** Goals follow a priority chain — workflow > session > legacy — adapted from agentmemory's fallback-provider pattern. When a workflow is bound, `goal.json` lives at `<workspace>/.brainrouter/workflows/<slug>/goal.json` next to spec.md / tasks.md / meta.json so the goal travels with the folder. When no workflow is bound, the post-Item-1 session-scoped path still applies. Every read/write entrypoint (`readGoal`, `setGoal`, `clearGoal`, `patchGoal`) routes through the single `resolveGoalScope` decision point. The Item 1 strict-session-scope invariant survives intact — when no workflow is bound, sessions still don't see each other's goals.

  - **`/workflow switch <slug>`.** Refocus on an existing workflow without creating a new one. Validates the slug, migrates any session-scoped goal into the target folder when relevant, flips the per-user current pointer, refreshes the system prompt, and prints `Switched to workflow <slug> — goal: <status>, iteration N of <cap>`. Refuses with `WorkflowConflictError` when BOTH the source AND the target are active workflows with active goals — the user must `/goal pause` or `/goal complete` one explicitly before flipping, so two independent threads of work don't merge silently.

  - **First-switch migration with conflict resolution.** When the user has been working in session scope and runs `/workflow switch <slug>`, their session goal migrates into the target workflow's folder. Idempotent — running it twice is a no-op. Conflict-safe — if the target already has a non-complete goal, the helper surfaces `conflict: 'target-has-active-goal'` and the slash handler prompts via `askYesNo` "Import session's goal into <slug>?" with `keep-target` as the default. The losing side is ALWAYS archived under `<cliStateDir>/.brainrouter.migrated/` so nothing is silently lost; the archive lives in CLI state (per-user, gitignored), not the workspace tree (which would pollute committable workflow folders, per Item 1's invariant).

  - **`/workflow pause` + `/workflow resume <slug>`.** Single-shot conveniences over the dispatcher. Pause halts the current workflow's goal-continuation loop and prints the exact `/workflow resume <slug>` incantation to come back. Resume is sugar for `/workflow switch <slug>` + `/goal resume` in one keystroke — re-uses the migration plumbing for safety, then fires the next iteration via `runAgentTurn` so the user doesn't have to type "proceed."

  - **`/workflows` is now a real switcher dashboard.** Each row carries the artifact-presence markers (`spec.md:✓  tasks.md:✓  walkthrough.md:·`) AND the workflow's own goal column (`goal:active 3/unlimited`, `goal:paused`, `goal:limited`, `goal:—`), so the user can scan-pick a workflow without chasing `/goal status` across candidates. Existing first/second-line column structure preserved so any script tail/grep'ing the listing isn't broken; new goal column appended to the right. The current-pointer marker is now `★` (replaces the previous `← current` text). Statusline `workflow` segment gains a halt-state suffix — `wf:auth-overhaul (paused)`, `wf:auth-overhaul (blocked)`, `wf:auth-overhaul (limited)` — when the bound workflow's goal isn't active, so the prompt line scans the halt state without needing the `goal` segment too.

  - **Clobber prompt on `/feature-dev` / `/spec` / `/review`.** Spawning a fresh workflow when one's already current AND that current has an active goal now prompts before flipping the pointer — same UX shape as `GoalConflictError`. `--force` on the slash command skips the prompt (for scripting and `spawn_agent` silent-child use). The detection helper `detectCreateWorkflowConflict` lives in workflowArtifacts.ts and reads `goal.json` directly to avoid a workflowArtifacts → goalStore import cycle.

  Out of scope for 0.3.6 (deferred to 0.4.x federation): concurrent goal execution within one CLI (`isProcessing` lock stays — the spec is explicit) and cross-workflow handoff. Multi-workflow concurrency here means "have multiple workflows in flight, switch between them"; not "run them both at the same time in the same REPL." If the user needs parallel execution today, two CLI windows on the same workspace is the supported pattern. (Item 3 of the 0.3.6 cycle — final item, cycle close-out.)
- **Relevance judge** — opt-in LLM gate after the reranker that drops memories that share keywords but aren't actually relevant. Off by default; enable with `BRAINROUTER_RELEVANCE_JUDGE_ENABLED=true`. Falls back to reranker output on any failure — a flaky judge never breaks recall.
- **Dashboard Markdown, math, and diagrams** — chat, persona, and scene cards render full Markdown with LaTeX (`\[…\]` / `\(…\)`); Working Memory canvas renders Mermaid diagrams with theme awareness.
- **CLI shell redesign.** Boxed startup banner with workspace + MCP profile + goal + session + model in one block; new `/where` command collapses workspace/workflow/goal/plan/recall/children into a single screen so you don't have to chain four commands to orient yourself; statusline gains `workflow`, `goal`, `plan`, `pr` segments alongside the existing ones; `/quiet` (also `brainrouter --quiet`) hides recall tables, briefing dumps, and tool-completion previews for clean screenshots; new `brainrouter-cli/src/cli/theme.ts` consolidates chalk colors with `BRAINROUTER_THEME=dark|light|mono` (`auto` falls through to `dark`); the bare `?` keystroke now opens `/help`; a one-time idle-help hint fires after 30s of REPL silence so first-time users find `/where` and `/help`; Node's `ExperimentalWarning` and dotenv-deprecation noise no longer scrolls the banner off the top of the terminal (filter installed via a tiny CJS bin shim that runs before any ESM imports — needed because ESM hoists `import 'node:sqlite'` ahead of any top-level code in `src/index.ts`).
- **`ask_user_choice` local tool with arrow-key picker.** Mid-turn the agent can pause, present 2–4 mutually exclusive options, and resume with the chosen label (or array of labels in `multiSelect` mode). UX matches Claude Code's `AskUserQuestion`: raw-mode picker with ↑/↓ to navigate, ENTER to confirm, SPACE to toggle in multi-select, q/Esc/Ctrl+C to cancel. An always-on **"Other"** row is appended to every prompt and drops to a free-text input — the user is never trapped between bad options. Pure reducer + renderer under the hood so the keystroke→state→render loop is unit-testable without faking a TTY. Pauses the parent REPL while active (`isPickerActive()` gates the existing shift+tab access-mode handler). Non-interactive runs (CI, piped, `brainrouter run`) surface a `NoTTYError` instead of defaulting to option 1 so the agent falls back to deciding itself with full context. User cancellation surfaces as `CancelledChoiceError` so "I declined to commit" is distinguishable from "I picked X". System prompt scopes the tool to "genuine ambiguity with 2–4 mutually exclusive reasonable approaches" — explicitly not a substitute for `askYesNo` confirmations or for thinking.
- **Structured reasoning-step capture in working memory** (PR #32). The agent now offloads a structured "why" step after every non-trivial tool batch (≥3 tool calls OR any tool that returned >2KB) via `memory_working_offload` with `kind: "reasoning"`, `title: "Why: <short>"`, and a 1-paragraph decision summary. Pairs with the existing ~1,000-token payload-offload rule — that one captures the tool output, the new one captures the audit trail. The working-memory canvas renders reasoning nodes with a distinct dashed border so the why-trail is visually separable from `tool_output` and `compressed_summary` nodes on `canvas.mmd`. The next turn's briefing surfaces the working-memory section structurally: a `Recent steps:` block plus a separate `Recent reasoning (why-trail):` block with the last 3 reasoning steps that fell off the recent tail — so a chatty tool burst can't push reasoning out of the model's view. (Item 2c of the 0.3.6 cycle.)
- **`/grill-me [--force] <task>` clarifying-questions command.** Pauses the agent for 2–5 clarifying questions before any file edit. Wraps the user's task in a CLARIFY-mode system overlay that forbids edits / shell / spawn for one turn and steers the model toward `ask_user_choice` for mutually-exclusive options. The overlay decays after the turn so subsequent plain prompts run normally. Skip-if-plan-exists guard: when the current workflow already has a `spec.md`, `/grill-me` refuses (and points at `/workflow switch <slug>`) unless `--force` is passed, so you don't re-litigate answers the user already gave. Pairs with `ask_user_choice` shipped earlier in this cycle.
- **`/effort low|medium|high` reasoning-depth preference.** Session-level knob for "how hard should the model think." `medium` is today's behaviour (no overlay, no provider slot forwarded — upgrade is a no-op). `low` overlays a "be terse, one-paragraph answers" directive; `high` overlays "reason step-by-step, audit evidence before each tool call." When the **model name** matches a known reasoning family (`gpt-5*`, `o1`/`o3`/`o4*`, `gpt-oss-*`, `deepseek-r1`/`r2`, `deepseek-v3`/`v4*`, `qwen3*`, `magistral*`, or anything with `reasoning`/`thinking` in the name), the level is also forwarded as `reasoning_effort` in the chat/completions body — enum borrowed verbatim from OpenAI's [`ReasoningEffort`](https://platform.openai.com/docs/api-reference/chat/create#chat_create-reasoning_effort). Works uniformly across OpenAI, DeepSeek, OpenRouter, LM Studio 0.3.29+ (`reasoning_effort` for `openai/gpt-oss-20b`), and Ollama. Non-reasoning models (`gpt-4o-mini`, `qwen2.5-coder`, etc.) skip the field. Anthropic-native (`claude-*` on `/v1/messages`) is intentionally not covered — different field shape (`thinking: { budget_tokens }`) needs a separate adapter. Resolution: `BRAINROUTER_EFFORT` env > preference > default. New `effort` statusline segment (hides on `medium`); `/where`'s Workspace block shows the level + an `(env)` tag when env beat the preference. Orthogonal to `/mode`. (Item 2f of the 0.3.6 cycle.)
- **`/mode` + `/review-policy` consolidate the approval knobs.** Two new session-level commands replace the scattered `/yolo` / `autoApproveShell` / "ask before applying?" decisions with one mental model. `/mode planning` (default) routes every `run_command` through y/N and keeps the agent leaning toward clarify-before-act; `/mode fast` skips the y/N for **safe** commands and still gates dangerous ones (`rm -rf`, `sudo`, `dd`, `git push --force`, `mkfs`, `kubectl delete`, `curl … \| sh`, …) through the prompt. `/review-policy request` (default) keeps the agent's "ready for your approval?" prose in front of multi-file changes; `/review-policy proceed` tells it to apply and report after. `/yolo on` becomes a one-line alias that flips both axes (`/mode fast` + `/review-policy proceed`); `/yolo off` restores both defaults. `/approve` is unchanged — it's still the explicit per-workflow approval gesture. Both new prefs surface in `/where`'s Workspace block, and a new `exec` statusline segment shows `fast` (planning is hidden as the default). Existing `autoApproveShell: true` prefs are auto-migrated to `executionMode: 'fast'` + `reviewPolicy: 'proceed'` on first read of the new fields; the legacy flag stays on disk for the alias transition. Dangerous commands in **silent child** agents are now always denied regardless of mode — silent children can't answer the y/N, so this is an incidental safety improvement over the pre-0.3.6 `/yolo on` behaviour. The auto-clarify-on-planning-mode pass mentioned in the original spec is deferred to a follow-up: `/grill-me` already gives an explicit lever for it, and the heuristic for "when is a prompt ambiguous enough to auto-clarify?" needs observation data first.

### Improvements
- **System-prompt trim (Item 9a).** The static portion of the system prompt fell from ~4,750 tokens to ~1,400 — a 70% cut without losing the load-bearing rules. Audit found most of the bulk was *static lecturing* (tool-call mechanics prose, multi-agent orchestration paragraphs, anti-hallucination repetition, full local-tool / MCP-tool name listings the model already gets via the API's tool list). The new prompt keeps a single canonical statement of each rule, moves the "right vs. wrong tool-call shape" example into one paragraph, deletes the Local Tools and BrainRouter MCP Tools name lists (the API ships them as structured tool descriptions), and consolidates the "asking the user mid-turn" / "surfacing tool output" sections to one-paragraph rules. A new budget assertion in `tests/prompt.test.ts` fails if the base prompt re-grows past 1,800 tokens — guards against a future rewrite that silently re-adds 2-3K tokens of repetition.
- **Memory recall gating (Item 9b).** Pre-9b every turn paid 3-10K tokens for a fresh briefing even on `thanks` / `/help` / single-word replies — recall fired unconditionally in `agent.ts:641`. The new default `gated` mode skips the briefing unless one of three triggers fires: (a) turn 1 of the session (no prior briefing exists), (b) the turn immediately after auto-compaction (the model just lost context — replay the briefing so it isn't blind), or (c) the user message contains ≥2 entity-shaped tokens (proper nouns, file paths, identifiers — heuristic detected locally without an LLM round-trip). When skipped, the prompt carries a one-line system-reminder `## Memory available (gated mode)` so the model knows it can pull recall itself via `memory_recall` if it needs to. New env knob `BRAINROUTER_RECALL_MODE=always|gated|off`: `gated` is the default, `always` preserves the pre-9b every-turn behaviour for users who measured better outcomes with it, `off` is the benchmarking escape hatch. The `recallHasFiredThisSession` + `recallNextTurnIsPostCompaction` flags on the Agent are session-boundary state, cleared by `loadHistory` / `fork` / `bootstrapSession` / `resetSessionCounters` so a `/new` / `/resume` re-pulls cleanly. `countEntityTokens` is exported and unit-tested directly.
- **Cache-friendly prompt ordering (Item 9c).** The system message now puts static identity + tool mechanics + memory section + behaviour rules FIRST, then the dynamic Runtime Context (workspace root, sessionKey, launch dir) + Workspace Instructions + per-call overlays at the tail. Anthropic and OpenAI prompt caches both key on prefix match — keeping the dynamic portion at the end maximizes cache-hit rates across turns in the same workspace. Test pins the ordering so a future refactor can't silently re-shuffle dynamic content to the front.
- **MCP identity + offline UX (Item 10).** When the BrainRouter MCP ("the brain") is offline, the user gets a clear signal and the model isn't lied to about which tools exist. (a) **Identity tagging** — new `ServerConfig.identity?: 'brainrouter' | 'third-party'` field; auto-detection runs in priority order: explicit config field > server-profile name prefix (`brainrouter*`) > URL host pattern (`*.brainrouter.cloud/.dev/.io/.com/.app`) > stdio command basename (`brainrouter` / `brainrouter-mcp`) > tool-signature fallback (first successful `listTools()` containing both `memory_recall` AND `list_skills`). Detection is cached on the wrapper, exposed via `McpClientWrapper.getIdentity()`. (b) **Dynamic system prompt** — `buildSystemPrompt` now takes `connectedMcpTools?: string[]`; when the list lacks `memory_recall`, the full Memory-First Workflow section is replaced with a `## ⚠️ BrainRouter MCP is OFFLINE this turn` block telling the model not to call any memory or skill tools (they'll fail with "MCP server is not connected") and to operate against the workspace directly. Back-compat: when the inventory is undefined (older callers), the prompt assumes brain online. The Agent refreshes `chatHistory[0]` whenever the inventory shape changes (online ↔ offline) so the model sees the right prompt on the very next turn. (c) **Brain-status surfaces** — the banner gains a `brain` row (`🟢 online` / `🔴 offline · cloud unreachable`) distinct from the generic `mcp` row, rendered only when the active MCP is BrainRouter; the new `brain` statusline segment opts in via `/statusline brain,…` and shows `brain:🔴` / `brain:🟡` for non-default states (online stays hidden, mirroring `exec`/`effort`); `/where`'s Workspace block adds a `brain` line right below `mcp` when identity resolves to brainrouter.
- **Multi-MCP foundation (Item 11, scope-limited).** The full federation story (parallel cross-MCP tool calls, MCP marketplace, capability tiers) stays in 0.4.0 — what ships here is the user-facing plumbing. New `/mcp` command file (`brainrouter-cli/src/cli/commands/mcp.ts`) with three subcommands: `/mcp list` shows every configured profile with identity tag (`brainrouter` / `third-party` / `unknown`), transport, online/offline state, and the URL or stdio command; `/mcp reconnect` closes the active wrapper and reconnects against the same profile (re-probes tools so identity refreshes); `/mcp tools` preserves the pre-Item-11 namespace-grouped tool listing the previous bare `/mcp` produced (no behaviour lost, just moved under a subcommand). The pre-Item-11 `/mcp` handler in `commands/ui.ts:212-244` deleted in favour of the consolidated dispatcher in `commands/mcp.ts`. `/mcp` is registered in `SLASH_COMMANDS` (tab-autocomplete) and `HELP_CATEGORIES.ui` with an updated description.
- **Goal-prompt deduplication (Item 9d).** Audit found goal text + budget counters injected on 3-4 surfaces every turn during a goal loop (the `goal-anchor` tagged system message, the foundational system message via `createSystemMessage`, the continuation prompt, and the separate `goal-budget-steering` tagged message on final-budget turns), plus `memory_task_state` re-injecting the same "what we're doing now" context through the briefing — ~8K-16K tokens of pure repetition over a 15-iteration loop. Each fact now has a single owner: the per-turn `goal-anchor` system message owns the goal text + budget + contract reminders, AND folds in the final-budget wrap-up directive automatically when `goalIsOnFinalBudgetTurn(goal)` flips. The foundational system message no longer embeds the goal block; the separate `goal-budget-steering` tagged message and its `buildBudgetSteeringMessage` builder are deleted; the goal-continuation prompt no longer re-echoes the goal text (replaced with a pointer to the anchor + compressed 2-line drift check); and the briefing skips `memory_task_state` when an active goal-anchor is present (still fires when no goal is active, so handover notes after `/goal pause` stay visible). `buildGoalContinuationPrompt` moved out of the REPL closure into `state/goalStore.ts` so it's unit-testable. Five `removeTaggedSystemMessage('goal-budget-steering')` defensive cleanup calls across `session.ts` + `workflow.ts` deleted alongside the message they used to clean up. 5 new tests in `goal.test.ts` + `memory.test.ts` + `agent-runtime.test.ts` lock in the ownership change.
- **`/goal` loops stay focused.** Goal text is re-anchored as a system message every turn; default budget is effectively unlimited (anti-spin and `/goal pause` remain the real safety nets); inline `budget: N iterations` works in the goal text itself.
- **Fan-out veto.** Phrases like "no spawn_agent" or "do this in one turn" reliably stop the agent from spawning child agents regardless of complexity score.
- **`.env` templates** reorganized into numbered sections; placeholder strings blanked so committed examples never look like real secrets. New `BRAINROUTER_RELEVANCE_JUDGE_*` tunables documented.

### Design changes
- **Goal and workflow decoupled (supersedes Item 3's per-workflow goal binding).** The original Item 3 ("multi-workflow concurrency") stored goal state inside `<workflow>/goal.json` so switching workflows would "carry the goal with it." That conflated two different concerns — a **goal** is per-session runtime intent ("let the agent run autonomously until done") while a **workflow** is durable storage (the spec.md / tasks.md / walkthrough.md folder, committed to git, shared across users). The conflation produced a cross-session goal leak: any two CLIs in the same workspace that landed on the same workflow shared its goal, silently reintroducing the cross-session leak PR #26 originally fixed. The first attempt (`feat/context-budget-and-mcp-identity` initial commit) papered over the leak by making the workflow binding per-session. The clean fix is to remove the coupling entirely: goals are **always session-scoped**, workflows are **pure storage + navigation**, with orthogonal lifecycles.
  - **`resolveGoalScope` priority chain collapses to `session → legacy`.** The workflow branch is gone. `<workflow>/goal.json` is never written by new code (users with existing files can delete them — they're now orphaned data).
  - **`/workflow switch <slug>` is now pure navigation.** Sets the per-session workflow pointer so subsequent `/spec` / `/feature-dev` / `/implement-plan` artifact writes land in the right folder. Does NOT touch goal state. The migration prompts (`migrateSessionGoalToWorkflow`, `applyMigrationResolution`, `planWorkflowSwitch`, `WorkflowConflictError`) and the clobber prompt (`detectCreateWorkflowConflict`) are deleted — they existed only to handle the now-impossible workflow-goal conflict.
  - **`/workflow pause` is now an alias for `/goal pause`** (works on the session goal). **`/workflow resume <slug>`** is sugar for `/workflow switch <slug>` + `/goal resume` if the session has a paused goal.
  - **`/workflows` listing** drops the goal column — workflows don't have goals. Artifact markers (`spec.md` / `tasks.md` / `walkthrough.md`) stay.
  - **`--force` on `/feature-dev` / `/spec` / `/review`** is now a silent no-op (workflows have no active goal to "clobber"). Flag retained for back-compat with any user muscle memory.
  - **Continuity for users who close and reopen the CLI:** the workspace-level `current-workflow.json` is preserved as a display-only "last used" hint. The banner surfaces a `last on   <slug>   /workflow switch <slug>` row when a fresh session has no binding but the workspace remembers one — opt-in continuity, no auto-bind.
  - **What this removes from the API:** `readWorkflowGoal`, `formatWorkflowGoalColumn`, `migrateSessionGoalToWorkflow`, `applyMigrationResolution`, `planWorkflowSwitch`, `WorkflowConflictError`, `GoalMigrationOutcome`, `GoalMigrationResolution`, `detectCreateWorkflowConflict`, `CreateWorkflowConflict`, `getWorkflowGoalFile`, `archiveGoalPayload`. All callers updated; the workflow segment in `statusline.ts` is now pure navigation (no goal halt-state annotation); `whereView.ts` keeps the workflow folder display and drops any goal-status references.
  - **Tests:** ~15 obsolete tests deleted (every test asserting workflow priority, migration, or workflow-goal conflict). 4 new tests assert the new contract: `resolveGoalScope` always returns session scope when sessionKey provided; `setGoal` writes to session bucket even when a workflow is bound; switching workflows doesn't touch the session goal; `pauseGoal` / `resumeGoal` operate at session scope regardless of binding. 2 new banner tests for the "last on" hint (renders when unbound + workspace has a last-used hint; suppressed when current workflow IS bound).

### Fixes
- **Backspace + shift+tab work in the REPL again.** A stray `setRawMode(false)` call at REPL startup (introduced in the original CLI commit, claiming to enable shift+tab keypress events) actually disabled raw mode that `readline.createInterface` automatically turns on for a TTY input. That broke Backspace at the `brainrouter[shell]>` prompt and silently disabled shift+tab access-mode cycling. Removed the call; readline's default behavior is now what we wanted all along.
- **Memory paths no longer corrupted.** The extractor's JSON-escape repair was silently turning Windows paths and Unix path segments like `\bin` / `\target` / `\release` into control characters when the LLM emitted malformed JSON. Path strings now survive intact.
- **Relevance judge survives LM Studio model auto-unload.** Detects the "no models loaded" 400, waits 1.5s, and retries once.
- **Goal stops leaking across sessions.** Each CLI process now gets a fresh sessionKey (a UUID at agent startup), so two concurrent CLIs in the same workspace no longer share goal / plan / working state. Previously the MCP `memory_resolve_session` workspace-cache handed every CLI in a workspace the same UUID, which surfaced as "A goal is already active" from a prior session on every fresh launch. Memory recall is unaffected — the memory DB is userId-scoped, sessionKey is just a grouping tag. The startup banner now prints the session prefix so you can tell two CLIs apart at a glance. Belt-and-suspenders: a secondary leak path where `readGoal(workspace, sessionKey)` silently fell through to the legacy `cli/goal.json` is also closed, and any leftover legacy file is archived to `cli/.brainrouter.migrated/` on the first session-scoped goal write.
- **`/tokens` no longer mixes in prior CLI runs.** Children were pulled straight from the workspace-wide `sessions.json` with no scope, so every child agent ever spawned in the workspace got summed into "this session" — surfacing as fake "Children (31) · 959,815↑ · 68 LLM calls · 1,010,693 total" on a fresh CLI process that had run a single turn. Now filtered by `parentSessionKey === agent.sessionKey`. `/resume` and `/fork` also zero the in-process parent counters (`sessionUsage`, `memoryMetrics`) since the persisted transcript doesn't record per-call usage and the pre-switch counts belong to a different session. `/rename` left alone (same conversation, just relabelled).
- **`/tokens` memory-savings figure no longer invented.** Dropped the 5× heuristic on briefing tokens and the synthetic "Total estimated savings"; briefing tokens are now labelled as a cost (already counted in parent ↑), and offload chars are the only thing presented as a measured saving. The ratio line also stops clipping small-but-nonzero values to `0.00` — falls back to `<0.01` when below the visible threshold.
- **Intermittent CI test failure fixed** — flaky JWT-tampering assertion (~1/64 base64 collision odds), previously misdiagnosed as a Node-20 crypto incompatibility.
- **REPL no longer freezes after `/working` (and every other spinner-based slash command) or `ask_user_choice` picker.** Pre-fix: after the spinner stopped, Backspace echoed `^?`, arrow keys echoed `^[[A` literally, ENTER didn't submit. Root cause: `ora`'s default `discardStdin: true` runs `stdin-discarder` which on `.stop()` does `stdin.pause()` + `setRawMode(false)` — that sequence drops readline's keypress listener (`emitKeypressEvents` ties the keypress listener's lifecycle to its underlying data listener), so subsequent `rl.resume()` re-engages raw mode but has no listener to translate keystrokes. Fixed by routing every `ora()` through a new factory at `brainrouter-cli/src/cli/spinner.ts` that always passes `discardStdin: false`. Spinner renders identically, side effects gone.

### Docs & tooling
- **`CLAUDE.md`** added as Claude Code's repo-level instructions (vendor-specific sibling to `AGENT.md`).
- **`openSrc/REFERENCES.md`** (gitignored) routes agents through vendored research projects so they don't grep the world.
- **`brainrouter-changelog/`** and **`brainrouter-roadmap/`** folders — per-version files split out of the previously-monolithic `CHANGELOG.md` and `ROADMAP.md`. Root files now act as overview + index; full detail lives in the folders.
- **CI**: Dependabot keeps React + React-DOM in lockstep; major-version bumps ignored until 0.3.6 ships; build runs in proper dependency order (`build:packages` → `build:apps`); Node matrix narrowed to 22.x (matches `engines.node`).

---

## [0.3.5] - 2026-05-22

Global-install UX fix.

- **`brainrouter-mcp init`** — scaffolds `~/.config/brainrouter/server.env` from the bundled template (chmod 0600). Won't overwrite an existing file.
- **Env-loader priority chain** — `$BRAINROUTER_ENV_FILE` → `~/.config/brainrouter/server.env` → `./.env`. Server prints which file it loaded at startup.
- **Published READMEs rewritten** for global-install users (the actual npm flow ending with `brainrouter` on `$PATH`); SETUP.md split into "install from npm" vs "clone and build" paths.

Backward compatible — existing monorepo dev (`brainrouter/.env`) still works in the third priority slot.

---

## Older releases

| Version | Date | Highlights |
|---|---|---|
| [0.3.4](brainrouter-changelog/0.3.4.md) | 2026-05-22 | First public npm release across four `@kinqs/` packages |
| [0.3.3](brainrouter-changelog/0.3.3.md) | 2026-05-21 | `/goal` state machine (`usage_limited`, token budget, wrap-up steering) |
| [0.3.2](brainrouter-changelog/0.3.2.md) | 2026-05-19 | Observability + headless + UX polish |
| [0.3.1](brainrouter-changelog/0.3.1.md) | 2026-05-17 | Reliability hardening — silent failures, races, edge cases |
| [0.3.0](brainrouter-changelog/0.3.0.md) | 2026-05-16 | Terminal Agent CLI + multi-agent orchestration + memory engine |
| [0.2.0](brainrouter-changelog/0.2.0.md) | 2026-05-15 | Admin & dashboard polish (Users console, Memories Hub, Contradiction UI) |

See [`brainrouter-changelog/README.md`](brainrouter-changelog/README.md) for the full per-version index and writing conventions.

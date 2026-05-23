# BrainRouter 0.3.6 Tasks

Living checklist for the 0.3.6 cycle. **Pick one top-level item to claim, tick subtasks as they complete, and check it off the build order at the bottom when the PR is merged.**

Full design rationale for every item lives in [`ROADMAP.md`](ROADMAP.md) under **"In-flight for 0.3.6"** — read that first.

Conventions:
- **One PR per item.** Granular commits within the PR are encouraged (see [`PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)).
- **Tests first.** All new code paths land with covering tests in the same PR (see `AGENT.md` / `CLAUDE.md` Core Development Rules).
- **Update CHANGELOG.md** under `[0.3.6] - Unreleased` for every PR that changes user-visible behavior.
- **Update this file** — tick the boxes as you go. The next agent reads ticked state to know what's done.

**Status:** Item 0 merged. **Item 1 (goal-leakage) is the next recommended pick** — WIP for it is preserved as `git stash@{0}` on local. See the build order at the bottom for the full sequence.

---

## Item 0 — Hotfix: JSON-escape repair corrupts paths (✅ MERGED — PR #22)

Surfaced during the 0.3.5 → 0.3.6 handoff code review. Was on `main` as part of PR #7. Silently corrupted any cognitive memory record whose extracted JSON contained Windows-style paths or Unix paths starting with `\b`/`\f`/`\n`/`\r`/`\t`.

**Resolution:** PR #22 narrowed the repair regex to preserve only `\"`, `\\`, `\/` as JSON escapes during the repair branch; everything else (including the previously-trusted `\b\f\n\r\t` and `\uXXXX`) gets doubled to literal. Tradeoff: legitimate `\n` in repair-branch content becomes literal two-char `\n`; happy-path `\n` still becomes a newline. Covered by [`brainrouter/src/__tests__/cognitive-extractor.test.ts`](brainrouter/src/__tests__/cognitive-extractor.test.ts) — 4 tests, all passing.

- [x] Reproduce the bug locally with the four-case test in [`brainrouter/src/memory/pipeline/cognitive-extractor.ts`](brainrouter/src/memory/pipeline/cognitive-extractor.ts) `parseJsonWithEscapeRepair`. Cases:
  - `C:\users\file` → was parsing with a form-feed character mid-path
  - `C:\bin\node.exe` → was parsing with backspace + newline
  - `/repos/\target/release` → was parsing with a tab
  - `\release\foo.txt` → was parsing with CR + form-feed
- [x] Fix the regex at [cognitive-extractor.ts:231](brainrouter/src/memory/pipeline/cognitive-extractor.ts:231). Replaced the lookahead `(?!["\\\/bfnrt]|u[0-9a-fA-F]{4})` with `(?!["\\\/])` (dropped bfnrt and u — when we're in the repair branch, JSON was already malformed; doubling ALL ambiguous backslashes is safer than silently corrupting paths).
- [x] Add a focused test fixture: a JSON payload with the four pathological path inputs above, plus one legitimate-escape input (`"line1\nline2"`) to confirm the conservative path still works. Lives at `brainrouter/src/__tests__/cognitive-extractor.test.ts` (new file).
- [x] Lock down `\uXXXX` behavior: happy path decodes to the code point, repair path preserves the literal escape (deliberate tradeoff with path correctness). Test added.
- [x] Document the behavior change in CHANGELOG.md under "Fixed".

**Acceptance:** ✅ all four path inputs round-trip with byte-identical bytes; legitimate `\n` in content becomes literal `\n` (two chars) in repair-branch output but newline (one char) on the happy-path. Tests cover both.

---

## Item 1 — Goal-leakage fix (recommended starting point after Item 0)

**Reported bug:** opening a new CLI session in the same workspace shows the previous session's goal as "already active." See [ROADMAP.md](ROADMAP.md) "In-flight for 0.3.6 → 1. Goal-leakage across sessions" for the full diagnosis.

- [ ] Update [`brainrouter-cli/src/state/goalStore.ts`](brainrouter-cli/src/state/goalStore.ts) — when `readGoal` is called with a sessionKey, return `null` if no session-scoped `goal.json` exists. Do NOT fall back to the legacy workspace-level path. (The fallback at lines 173-176 is the bug.)
- [ ] Preserve the no-sessionKey fallback branch (for very old installs that never had session-scoped goals).
- [ ] One-shot migration: on the first `setGoal` of a new session that finds an existing legacy `<workspace>/cli/goal.json`, rename it to `<workspace>/cli/.brainrouter.migrated/legacy-goal-<timestamp>.json`. Use the existing `getCliStateFile` + `path.rename` machinery — don't reinvent.
- [ ] New regression test in [`brainrouter-cli/src/agent.test.ts`](brainrouter-cli/src/agent.test.ts): "Setting a goal in session A, opening session B, calling `readGoal(B)` returns null." Currently fails.
- [ ] Re-run the affected callers and confirm they still behave: `/goal` slash handler in [workflow.ts:373+](brainrouter-cli/src/cli/commands/workflow.ts:373), the eager-init path in [`agent/agent.ts`](brainrouter-cli/src/agent/agent.ts), the goal-continuation loop in [`cli/repl.ts`](brainrouter-cli/src/cli/repl.ts).

**Acceptance:** fresh CLI session shows no inherited goal from prior session. Test added. CHANGELOG.md updated.

---

## Item 2 — CLI shell redesign

Six independent sub-deliverables. Can ship as one PR or split.

- [ ] **Suppress Node SQLite/dotenv experimental warnings.** Launch with `NODE_NO_WARNINGS=1` or a filtered `process.emitWarning` interceptor in [`brainrouter-cli/src/index.ts`](brainrouter-cli/src/index.ts).
- [ ] **Structured boxed startup banner.** Replace the current two-line text with a small banner showing: workspace name + short hash, MCP profile + transport, current workflow + goal status, session id prefix, model.
- [ ] **Persistent status line above the prompt.** `[workflow:slug · goal:active 2/∞ · model:gpt-4o · session:7f3a · plan:1/4]`. Configurable via `/statusline mode,workflow,goal,model,session,plan,pr`. Extend the existing `/statusline` handler in [`brainrouter-cli/src/cli/commands/`](brainrouter-cli/src/cli/commands/).
- [ ] **`/where` single-screen state view.** Workspace + active workflow + goal text + budget + active plan items + recent recall scores + active child agents.
- [ ] **`--quiet` / `/quiet` toggle.** Suppress recall-scoring tables, briefing dumps, tool-completion previews — leaves only model prose.
- [ ] **Themeable surface chrome.** Move chalk colors from scattered command files into `brainrouter-cli/src/cli/theme.ts`. `BRAINROUTER_THEME=dark|light|mono`.
- [ ] **Idle help hint.** Footer hint after 30s idle: "Press `?` for help, `/where` to see current state." One-time-per-session, dismissible.

**Acceptance:** banner clean, status line readable, `/where` lands every key state in one view, theme module consolidated, idle hint fires once max per session. Tests cover the new helpers and the `/where` aggregation.

---

## Item 2b — `ask_user_choice` local tool

Multi-choice mid-turn prompt for the agent. See [ROADMAP.md](ROADMAP.md) "In-flight for 0.3.6 → 4."

- [ ] **New helper `askChoice` in [`brainrouter-cli/src/cli/cliPrompt.ts`](brainrouter-cli/src/cli/cliPrompt.ts)** alongside `askYesNo`. Signature: `askChoice(question, options: Array<{label, description}>, opts?: { multiSelect?: boolean })`. Validate option number OR partial label match (case-insensitive, refuse on ambiguous prefix — surface that case explicitly).
- [ ] **Non-TTY behavior: error, not silent default.** Choice prompts must NOT silently pick option 1 for the agent.
- [ ] **Register as `ask_user_choice` local tool** in [`brainrouter-cli/src/agent/agent.ts`](brainrouter-cli/src/agent/agent.ts) tool registry (alongside `run_command`, `read_file`, etc.). Signature: `{ question, header, options, multiSelect? } → { answer }`.
- [ ] **System-prompt rule** in [`brainrouter-cli/src/prompt/systemPrompt.ts`](brainrouter-cli/src/prompt/systemPrompt.ts): "Call `ask_user_choice` when there's genuine ambiguity with 2–4 mutually exclusive reasonable approaches. Do NOT use for trivial confirmations (`askYesNo` covers those), things you can decide yourself, or as a substitute for thinking."
- [ ] **Tests in agent.test.ts:** mock readline, fake `rl.question` replies, verify chosen option returned, out-of-range answers rejected, no-TTY error surfaced.

**Acceptance:** new tool callable mid-turn, returns the user's choice or errors on non-TTY, system prompt explains when to use, tests cover the three paths.

---

## Item 2c — Reasoning-step capture in working memory

The "why" trail. See [ROADMAP.md](ROADMAP.md) "In-flight for 0.3.6 → 5."

- [ ] **Verify** that [`brainrouter/src/memory/working/canvas.ts`](brainrouter/src/memory/working/canvas.ts) already renders steps by `kind` in the Mermaid tree. If yes, no canvas change needed. If no, add a distinct node style for `kind: "reasoning"` (dashed border or similar).
- [ ] **System-prompt rule** in [`brainrouter-cli/src/prompt/systemPrompt.ts`](brainrouter-cli/src/prompt/systemPrompt.ts): "After every non-trivial tool batch (≥3 tool calls OR any tool with >2KB output), call `memory_working_offload` once with `kind: \"reasoning\"`, `title: \"Why: <short>\"`, and a 1-paragraph summary of the decision you made and why (NOT what the tools returned)."
- [ ] **Briefing surface** in [`brainrouter-cli/src/memory/briefing.ts`](brainrouter-cli/src/memory/briefing.ts): when assembling the working-memory section, surface the last 3 `kind: "reasoning"` steps in the recentSteps tail alongside tool outputs. Cap to avoid stuffing.
- [ ] **Round-trip test** for `kind: "reasoning"` in [`brainrouter/src/__tests__/working-memory.test.ts`](brainrouter/src/__tests__/working-memory.test.ts).
- [ ] **CLI-side prompt-assembly test:** confirm the new system-prompt line actually appears in the assembled prompt.

**Acceptance:** agent offloads a reasoning step after each substantial tool batch; `/working` canvas shows reasoning nodes visually distinct from tool outputs; next-turn briefing surfaces the last 3 reasoning steps. Tests cover both ends.

---

## Item 3 — Multi-workflow concurrency

Depends on Item 1 (correct goal-scoping primitive). See [ROADMAP.md](ROADMAP.md) "In-flight for 0.3.6 → 3."

- [ ] **`/workflow switch <slug>`** — refocus on an existing workflow. Updates `current-workflow.json` pointer; loads the workflow's saved goal state. Refuses if source workflow's goal is `active` and would conflict with target's `active` — user must pause/complete the source first.
- [ ] **Per-workflow goal binding.** Move goal persistence from `<session>/goal.json` to `<workflow>/goal.json` when a workflow is bound. Quick-task path (no workflow bound) falls back to the per-session path from Item 1.
- [ ] **Migration on first switch:** session's existing `goal.json` moves into the target workflow's folder. Idempotent.
- [ ] **`/workflows` upgrade** — show per-workflow goal status, iteration budget usage, spec/tasks/walkthrough markers. Make the list a real switcher dashboard.
- [ ] **`/workflow pause` + `/workflow resume <slug>`** — pause current workflow's goal; resume by slug (combines `/workflow switch` + `/goal resume`).
- [ ] **Conflict prompt on `createWorkflow()`** — when `/feature-dev` or `/spec` would clobber an in-progress workflow's current pointer, prompt before flipping. Same UX shape as `GoalConflictError`.

**Acceptance:** can have multiple in-progress workflows, switch between them without losing goal state, status surfaces in `/workflows`. Tests cover the switch + per-workflow goal binding + clobber-prompt paths.

---

## Build order (tick when merged)

- [x] **Item 0** — JSON-repair hotfix — merged in [PR #22](https://github.com/kinqsradiollc/BrainRouter/pull/22) on 2026-05-23
- [ ] **Item 1** — Goal-leakage fix *(recommended next; WIP preserved on `git stash@{0}`)*
- [ ] **Item 2** — CLI shell redesign
- [ ] **Item 2b** — `ask_user_choice` tool
- [ ] **Item 2c** — Reasoning-step capture
- [ ] **Item 3** — Multi-workflow concurrency

Items 2 / 2b / 2c are independent and can land in any order. Item 3 must come after Item 1.

---

## Other follow-ups (not blocking 0.3.6)

These came out of the 0.3.5 → 0.3.6 handoff code review. Each is genuinely small. Pick up when convenient; they don't need to gate the release.

- [ ] **Add a "kept in sync with X — edit both" note** at the top of [`CLAUDE.md`](CLAUDE.md) and [`AGENT.md`](AGENT.md) so the duplication doesn't silently drift.
- [ ] **Improve judge retry diagnostics** in [`brainrouter/src/memory/store/relevance-judge.ts`](brainrouter/src/memory/store/relevance-judge.ts): if the LM Studio retry also hits a "no models loaded" 400, the thrown error should flag that the retry hit the same condition (instead of just "HTTP 400").
- [ ] **Log when judge returns a partial verdict set** at [`brainrouter/src/memory/store/relevance-judge.ts:222`](brainrouter/src/memory/store/relevance-judge.ts:222) — `parseVerdicts` defaults missing entries to `relevant: false` (right choice), but when `byIndex.size < candidateCount` we should `console.error` so it's diagnosable.
- [ ] **Document the security-advisory carve-out** in [`.github/dependabot.yml`](.github/dependabot.yml) — the `ignore` block for majors does NOT suppress Dependabot security PRs (they still flow). Add an inline comment so the next reader doesn't assume "ignore = total freeze."
- [ ] **Add `relevance-judge` tests** (no test file exists today): mock fetch, exercise the LM Studio retry branch, the non-`unloaded`-400 branch, the `data.error` envelope branch, and `parseVerdicts` defaulting to `relevant: false` when a candidate index is missing.
- [ ] **Revisit Node 20.x in the CI matrix.** The inline comment in [`.github/workflows/ci.yml:33`](.github/workflows/ci.yml:33) blames `crypto.timingSafeEqual` for the JWT-tampering failure on Node 20. PR #22 proved that was actually flakiness (~1/64 base64 collision), not a Node-version incompat. With the flakiness fixed, Node 20 may pass — the genuine blockers left are `node:sqlite` stability (only stable in 22+) and the recursive `**` glob in `node --test`. Reassess whether to add Node 20 back to the matrix after Item 0 is shipped to npm.

---

*Last updated: 2026-05-23 (after Item 0 / PR #22 merged). Update the date when you tick boxes.*

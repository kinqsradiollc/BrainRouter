# Changelog

All notable changes to BrainRouter.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

The full per-version history lives in [`brainrouter-changelog/`](brainrouter-changelog/) — one file per release. The current in-flight version (`[Unreleased]`) and the most-recent shipped release are inlined below for at-a-glance scanning; everything older is one click away.

---

## [0.3.6] - Unreleased

Smarter memory recall, friendlier dashboard, more reliable agent loop.

### Features
- **Relevance judge** — opt-in LLM gate after the reranker that drops memories that share keywords but aren't actually relevant. Off by default; enable with `BRAINROUTER_RELEVANCE_JUDGE_ENABLED=true`. Falls back to reranker output on any failure — a flaky judge never breaks recall.
- **Dashboard Markdown, math, and diagrams** — chat, persona, and scene cards render full Markdown with LaTeX (`\[…\]` / `\(…\)`); Working Memory canvas renders Mermaid diagrams with theme awareness.
- **CLI shell redesign.** Boxed startup banner with workspace + MCP profile + goal + session + model in one block; new `/where` command collapses workspace/workflow/goal/plan/recall/children into a single screen so you don't have to chain four commands to orient yourself; statusline gains `workflow`, `goal`, `plan`, `pr` segments alongside the existing ones; `/quiet` (also `brainrouter --quiet`) hides recall tables, briefing dumps, and tool-completion previews for clean screenshots; new `brainrouter-cli/src/cli/theme.ts` consolidates chalk colors with `BRAINROUTER_THEME=dark|light|mono` (`auto` falls through to `dark`); the bare `?` keystroke now opens `/help`; a one-time idle-help hint fires after 30s of REPL silence so first-time users find `/where` and `/help`; Node's `ExperimentalWarning` and dotenv-deprecation noise no longer scrolls the banner off the top of the terminal (filter installed via a tiny CJS bin shim that runs before any ESM imports — needed because ESM hoists `import 'node:sqlite'` ahead of any top-level code in `src/index.ts`).
- **`ask_user_choice` local tool with arrow-key picker.** Mid-turn the agent can pause, present 2–4 mutually exclusive options, and resume with the chosen label (or array of labels in `multiSelect` mode). UX matches Claude Code's `AskUserQuestion`: raw-mode picker with ↑/↓ to navigate, ENTER to confirm, SPACE to toggle in multi-select, q/Esc/Ctrl+C to cancel. An always-on **"Other"** row is appended to every prompt and drops to a free-text input — the user is never trapped between bad options. Pure reducer + renderer under the hood so the keystroke→state→render loop is unit-testable without faking a TTY. Pauses the parent REPL while active (`isPickerActive()` gates the existing shift+tab access-mode handler). Non-interactive runs (CI, piped, `brainrouter run`) surface a `NoTTYError` instead of defaulting to option 1 so the agent falls back to deciding itself with full context. User cancellation surfaces as `CancelledChoiceError` so "I declined to commit" is distinguishable from "I picked X". System prompt scopes the tool to "genuine ambiguity with 2–4 mutually exclusive reasonable approaches" — explicitly not a substitute for `askYesNo` confirmations or for thinking.
- **Structured reasoning-step capture in working memory** (PR #32). The agent now offloads a structured "why" step after every non-trivial tool batch (≥3 tool calls OR any tool that returned >2KB) via `memory_working_offload` with `kind: "reasoning"`, `title: "Why: <short>"`, and a 1-paragraph decision summary. Pairs with the existing ~1,000-token payload-offload rule — that one captures the tool output, the new one captures the audit trail. The working-memory canvas renders reasoning nodes with a distinct dashed border so the why-trail is visually separable from `tool_output` and `compressed_summary` nodes on `canvas.mmd`. The next turn's briefing surfaces the working-memory section structurally: a `Recent steps:` block plus a separate `Recent reasoning (why-trail):` block with the last 3 reasoning steps that fell off the recent tail — so a chatty tool burst can't push reasoning out of the model's view. (Item 2c of the 0.3.6 cycle.)
- **`/grill-me [--force] <task>` clarifying-questions command.** Pauses the agent for 2–5 clarifying questions before any file edit. Wraps the user's task in a CLARIFY-mode system overlay that forbids edits / shell / spawn for one turn and steers the model toward `ask_user_choice` for mutually-exclusive options. The overlay decays after the turn so subsequent plain prompts run normally. Skip-if-plan-exists guard: when the current workflow already has a `spec.md`, `/grill-me` refuses (and points at `/workflow switch <slug>`) unless `--force` is passed, so you don't re-litigate answers the user already gave. Pairs with `ask_user_choice` shipped earlier in this cycle.
- **`/mode` + `/review-policy` consolidate the approval knobs.** Two new session-level commands replace the scattered `/yolo` / `autoApproveShell` / "ask before applying?" decisions with one mental model. `/mode planning` (default) routes every `run_command` through y/N and keeps the agent leaning toward clarify-before-act; `/mode fast` skips the y/N for **safe** commands and still gates dangerous ones (`rm -rf`, `sudo`, `dd`, `git push --force`, `mkfs`, `kubectl delete`, `curl … \| sh`, …) through the prompt. `/review-policy request` (default) keeps the agent's "ready for your approval?" prose in front of multi-file changes; `/review-policy proceed` tells it to apply and report after. `/yolo on` becomes a one-line alias that flips both axes (`/mode fast` + `/review-policy proceed`); `/yolo off` restores both defaults. `/approve` is unchanged — it's still the explicit per-workflow approval gesture. Both new prefs surface in `/where`'s Workspace block, and a new `exec` statusline segment shows `fast` (planning is hidden as the default). Existing `autoApproveShell: true` prefs are auto-migrated to `executionMode: 'fast'` + `reviewPolicy: 'proceed'` on first read of the new fields; the legacy flag stays on disk for the alias transition. Dangerous commands in **silent child** agents are now always denied regardless of mode — silent children can't answer the y/N, so this is an incidental safety improvement over the pre-0.3.6 `/yolo on` behaviour. The auto-clarify-on-planning-mode pass mentioned in the original spec is deferred to a follow-up: `/grill-me` already gives an explicit lever for it, and the heuristic for "when is a prompt ambiguous enough to auto-clarify?" needs observation data first.

### Improvements
- **`/goal` loops stay focused.** Goal text is re-anchored as a system message every turn; default budget is effectively unlimited (anti-spin and `/goal pause` remain the real safety nets); inline `budget: N iterations` works in the goal text itself.
- **Fan-out veto.** Phrases like "no spawn_agent" or "do this in one turn" reliably stop the agent from spawning child agents regardless of complexity score.
- **`.env` templates** reorganized into numbered sections; placeholder strings blanked so committed examples never look like real secrets. New `BRAINROUTER_RELEVANCE_JUDGE_*` tunables documented.

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

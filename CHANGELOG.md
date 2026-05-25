# Changelog

All notable changes to BrainRouter.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) · Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

The full per-version history lives in [`brainrouter-changelog/`](brainrouter-changelog/) — one file per release. The current in-flight version (`[Unreleased]`) and the most-recent shipped release are inlined below for at-a-glance scanning; everything older is one click away.

---

## [0.3.7] - Unreleased

In-terminal configuration wizard, redesigned `/config` settings panel,
**and the full Ink chat REPL** — every surface (banner, composer,
scrollback, tool events, slash palette, footer) now diffs through one
Ink tree instead of the readline + ANSI loop. The CLI feels like
Claude Code / Codex / Grok-CLI / DeepSeek-TUI across the board:
picker-driven first-run, claude-code-style `⏺/⎿/◉` glyphs throughout
the turn loop, progressive collapse on resize, no JSON editing, no
separate `brainrouter login` / `brainrouter config` subcommand dance.

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
- **Full Ink chat REPL** (originally a 0.3.8 target, pulled forward
  to close the split-aesthetic gap left by the wizard rebuild).
  Banner, composer, scrollback, tool events, slash palette, and
  footer status all render through one diffed Ink tree in
  [`cli/ink/ChatApp.tsx`](brainrouter-cli/src/cli/ink/ChatApp.tsx)
  +
  [`runChat.tsx`](brainrouter-cli/src/cli/ink/runChat.tsx).
  Scrollback uses claude-code-style glyphs (`⏺` turn / tool header
  in green/red, `⎿` preview connector, `◉ access` pill colored by
  mode, `●/◐/○` effort glyphs). The spinner warms from green to
  amber after 10s on a single turn (claude-code's "still working"
  cue from v2.1.130). Markdown rendering rebuilt as a single
  `<Text>` per turn so multi-line blockquotes / lists keep their
  styling across newlines
  ([`markdownRender.ts`](brainrouter-cli/src/cli/ink/markdownRender.ts)).
  Tool-call previews get diff-aware coloring
  ([`toolFormat.ts`](brainrouter-cli/src/cli/ink/toolFormat.ts)).
- **Inline slash command palette.** Typing `/` opens a scrollable,
  navigable list below the composer (10 rows visible, viewport
  follows cursor, `↑ N more`/`↓ N more` hints at edges, fuzzy
  ranking startsWith → contains → description-match). Tab
  autocompletes the highlighted command; Enter submits; Esc /
  backspace past `/` cancels. Implementation: panel mode in
  [`cli/ink/ChatApp.tsx`](brainrouter-cli/src/cli/ink/ChatApp.tsx)
  (no second Ink mount; lives inside the chat tree).
- **In-chat overlay for `/config`, `/login`, `/init`.** Slash
  commands that need their own picker render INSIDE the chat Ink
  via a `ChatController.showOverlay` slot
  ([`ambientChat.ts`](brainrouter-cli/src/cli/ink/ambientChat.ts)).
  Mounting a second Ink instance on `process.stdin` made both
  instances grab raw mode and split keystrokes unpredictably —
  the bug behind `/config` hanging inside the chat. The overlay
  path is the structural fix; the standalone path (for the legacy
  readline REPL) still works via the same `runPicker` helper.
- **Progressive collapse on resize** (footer / palette / hint row
  shed segments at width breakpoints — 80 → 60 → 50 → 40 cols →
  floor of just the `◉ access` pill). Dividers + footer + palette
  reflow via a dedicated `useTerminalSize` hook that subscribes to
  `stdout.on('resize')` and force-renders. Every Ink mount also
  goes through
  [`renderWithResizeClear`](brainrouter-cli/src/cli/ink/renderWithResizeClear.ts)
  which clears the screen before Ink's own resize redraw — needed
  because Ink only force-clears on some resize paths, and full-frame
  panels leave residue otherwise.

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

- **80+ new tests** across `wizard.test.ts`, `config-command.test.ts`,
  `ink-chat.test.ts`, `markdown-render.test.ts`, `tool-format.test.ts`,
  `slash-suggest.test.ts`, `picker.test.ts`, `models-api.test.ts`.
  Coverage at a glance: `STEP_ORDER` invariants, `reduceWizard`
  advance / back / abort / warn / commit transitions; provider catalog
  shape, env-based provider detection precedence; API-key validation
  tier (accept / reject / warn-not-block) + masking; picker
  `prefilledOther` + `initialCursor` semantics; `/config`
  argument-parsing routing (home / raw / get / set / trimmed values);
  scrollback entry shapes; markdown fence unwrap + per-line ANSI
  re-scope; diff classification (add / del / hunk); `formatToolCall`
  shapes (Read / Bash / Edit / Write / mcp_ namespaced); slash palette
  filter ranking. Full suite: brainrouter 262/262 + brainrouter-cli
  319/319 = 581 green. `npx tsc --noEmit` clean across both packages.

---

## [0.3.6] - 2026-05-25

Smarter recall, friendlier CLI, more reliable agent loop. Full notes: [`brainrouter-changelog/0.3.6.md`](brainrouter-changelog/0.3.6.md).

- **Multi-workflow concurrency.** `/workflow switch <slug>` flips between `/feature-dev` / `/spec` / `/review` workflows; `/workflows` lists them with artifact markers. Goals stay session-scoped (workflows are pure storage + navigation).
- **New session knobs.** `/effort low|medium|high` (forwarded as `reasoning_effort` to gpt-5 / o-series / gpt-oss / deepseek-r/v / qwen3 / magistral), `/mode planning|fast` + `/review-policy request|proceed` (replace `/yolo` + `autoApproveShell`), `/grill-me <task>` (2–5 clarifying questions before any edit), `ask_user_choice` (mid-turn arrow-key picker).
- **Context budget — 70% lighter system prompt + gated recall.** Static prompt cut from ~4,750 → ~1,400 tokens; briefing fires only on turn 1, post-compaction, or messages carrying ≥2 entity-shaped tokens. Goal text deduplicated to a single per-turn anchor.
- **MCP identity + offline UX + multi-MCP foundation.** BrainRouter MCP auto-detected; when offline, system prompt swaps to a `⚠️ OFFLINE` block and banner/statusline gain a distinct `brain` indicator. New `/mcp list` / `/mcp reconnect` / `/mcp tools`.
- **REPL stdin no longer freezes** after spinner-based slash commands.

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

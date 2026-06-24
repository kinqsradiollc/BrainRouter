# Changelog — BrainRouter Mobile

All notable changes to the **mobile** app. Format: [Keep a Changelog](https://keepachangelog.com/). This starter log documents the **desktop → mobile** transition: what's **Added** (mobile-native), **Adapted** (reshaped from desktop), **Removed/Deferred** (desktop-only), and the **Architecture** shift. Updated as Phase 3 features land.

> Companion to the repo-root `CHANGELOG.md` (desktop/CLI/core). Versions track the desktop `0.4.x` line.

---

## [Unreleased]

### Reasoning-model display fixes (verified live against a local Qwen 3.5-9B)

Tested the wired turn loop end-to-end against a local llama.cpp model and fixed two
display issues the transcript reducer had with reasoning models (TDD — 6 new cases in
`transcript.test.ts`, all green):

- **Inline `<think>…</think>` no longer pollutes the answer bubble.** The reducer now
  accumulates the raw assistant stream and re-derives the leading reasoning block each
  delta via the existing (tested) `parseThink`, routing chain-of-thought to a `reasoning`
  row and keeping the answer clean — live, as it streams. Leading-only by design, so a
  `<think>` that appears mid-answer (e.g. literal text/code) is left untouched. Stable row
  ids; empty/whitespace `<think>` blocks and the placeholder row are dropped at turn end.
- **The benign first-turn `turn-error: "No transcript found"` is suppressed** (the recall
  step finds no prior transcript on a brand-new session) — it no longer renders as a red
  error notice in the chat.

`host/qwen-turn.mjs` drives the real host + real model the way the Session screen does and
confirms both: answer `think-tags=STRIPPED`, reasoning captured in its own row, no notice.

### Real-host API — verified against the live runtime (no mock)

- **Added `host/api.integration.test.mjs` (`npm run test:api`, 27 tests):** boots the
  REAL desktop agent host headless (no Electron) on this repo and drives it with the
  REAL `RemoteTransport` over a loopback WebSocket, asserting **every query the screens
  make** returns real, correctly-shaped data (git status, worktrees, files, file bytes,
  review gate, context usage, shell output, the Layer-1 methods) and that `start-turn`
  drives the live core. Boot recipe: redirect `HOME` to a throwaway test-home with a
  minimal config so the shared `loadConfig` doesn't hard-exit; `host/smoke-real.mjs` is
  the matching manual smoke.
- **Fixed shape mismatches the mock had hidden** (would have silently broken on a real
  host): `changed-files` is a bare `Array<{status,path}>` with no per-file counts —
  `ChangesScreen` now reads the array and takes the aggregate `+/-` from `git-info`;
  `context-usage` exposes `pct` (no `max`) — the Session ring uses it directly.
  `MockTransport` was realigned to the real shapes so mock and host stay interchangeable.
- Confirmed pairing swaps **every** screen to the live transport (App → reactive
  `connectionStore` → `TransportProvider`; `ConnectScreen.connect()`) — no permanent mock.

### Milestone 0 — Foundations (engineering pre-req, no user-facing release)

The skeleton everything else builds on (roadmap.md M0; technical-doc.md §4). All
work is under `brainrouter-mobile/`; the RN deps are declared but not installed
(to avoid reconciling the shared monorepo `node_modules`), so the **pure layer**
is verified with the repo's pinned `tsc` + `tsx`.

- **Expo scaffold** (managed, TypeScript strict, SDK 52): `package.json`,
  `app.json`, `eas.json`, `babel.config.js`, `metro.config.js` (monorepo-aware),
  `index.ts` entry, `jest.config.js` (RN tests) + a standalone `tsconfig.domain.json`
  for the pure-layer typecheck. §4 folder structure under `src/`.
- **Theme** (`theme/tokens.ts` + `ThemeProvider`): tokens ported 1:1 from
  `prototypes/global.css` — dark + light palettes, the desktop indigo/purple
  accent `hsl(245 80% 66%)`, radius/spacing/type scales, and a runtime
  theme/accent override.
- **Transport seam** (§6): `transport/protocol.ts` re-exports
  `@kinqs/brainrouter-agent-protocol` verbatim; `BrainRouterTransport` interface
  (send/onEvent/query + Layer-1 promise methods + status); `MockTransport`
  mirroring `devBridge.ts`'s core loop (streaming echo turn + tool group +
  approval gate on "approve", plus a representative query/Layer-1 dataset).
- **Storage seam**: `Storage` interface + `InMemoryStorage` (pure) and a native
  MMKV + SecureStore implementation (`nativeStorage.ts`).
- **Navigation shell**: root native-stack (Connect | App) → bottom tabs
  (Chats · Activity · Review · Settings), each a native stack; token-mapped
  React Navigation theme + deep-link config; `TransportProvider` context.
  Screens: S-02 (sessions list, live from the transport), S-03 (event-stream
  proof), S-14 (theme/accent controls); S-01/07/10/11 placeholders.
- **Ported `domain/**` verbatim** (logic byte-identical; only import specifiers
  adjusted for the new layout): all `*View.ts` view-models, the JQL parser
  (`parse/query`), RBAC (`permissions`), diff/think/slash/worktree parsers,
  command core, model capabilities, CI formatting, session/workspace logic, and
  `format.ts` (minus the DOM `download()`, per §6). **All ported unit tests came
  with them: 178 pass / 0 fail across 27 files** (`tsx --test`, verbatim).

---

## [0.1.0] — MVP (planned) · "Remote control for your coding agent"

### Architecture (the defining change)
- **Mobile is a thin client to a remote `brainrouter-core` host.** The Node-only agent runtime stays on a desktop/CLI/server; the app drives it over an authenticated WebSocket. (Desktop ran the runtime in-process via an Electron `utilityProcess`.)
- **Wire protocol reused verbatim:** `@kinqs/brainrouter-agent-protocol` becomes the network contract (was Electron IPC). `EventEnvelope.seq` powers reconnect/replay.
- **New backend component:** `brainrouter-host` — a thin WS/SSE server wrapping the existing Electron-free `createHostCore`.
- **Pure logic ported verbatim:** all `*View.ts` view-models, the JQL parser, RBAC, diff parsing, command/slash logic, model-capability heuristics, workspace event routing, design tokens, and the icon set move with minimal change.

### Added (mobile-native, no desktop equivalent)
- **Host pairing** (Connect screen) with URL/token + QR pairing and SecureStore persistence.
- **Push notifications** for tool approvals and turn-complete/error, deep-linking to the approval (turns the remote agent from a liability into the core value).
- **[REC] Biometric gate** (Face/Touch ID) before approving shell/git actions.
- **Connection-state surface** — Connected/Reconnecting/Offline indicator, stale-data dimming, `seq` resync on reconnect.
- **Pull-to-refresh**, **gesture vocabulary** (swipe tabs, swipe-row pin/archive, long-press menus), and **haptics** on consequential actions.
- **Bottom-tab navigation** (Chats · Activity · Review · Settings).

### Adapted (same capability, reshaped for touch)
- **Multi-pane workbench → tabs + stack + sheets.** Environment column, ViewsRail panels, and Terminal dock become routes/sheets.
- **Inline approval card → prominent banner + Approval sheet + push.**
- **Composer popovers (Mode/Model/Effort/Branch) → bottom sheets** with capability previews.
- **Hover actions & `title=` tooltips → always-visible controls, long-press sheets, tap-to-expand.**
- **Right-click / nested flyout menus → action sheets.**
- **Command palette (⌘K) → in-composer slash picker** + header search.
- **`window.prompt` → custom input modal; blur-to-save → explicit Save.**
- **Settings two-pane modal → drilldown list.**
- **Dense tables → stacked responsive cards;** diff → single-column unified view.
- **Multi-window (per-workspace) → single view + in-app workspace switcher.**
- **localStorage → MMKV + SecureStore.**
- **react-markdown → react-native-markdown-display; react-syntax-highlighter → RN variant; SVG icons → react-native-svg.**

### Features at parity (MVP)
- Browse projects/sessions; new/resume/manage sessions (pin/rename/fork/archive/delete/export).
- Core agent loop: send turns, live streaming (text/reasoning/tools), interrupt, slash commands, attachments, goals.
- Plan review & approval; tool approvals & interaction questions.
- Changes & diffs (read), commit/push with the review gate.
- Code review: run + triage findings.
- Cross-workspace dashboard; background-task/workflow transcripts; stop tasks.
- Token/context usage; model/provider settings; appearance; workspace trust.

### Removed / Deferred (desktop-only)
- **In-app Monaco editor** → deferred (v1 read-only file view; future RN/WebView editor).
- **xterm terminal** → deferred/optional (host runs the shell; no on-device shell).
- **Worktree management, Track kanban (DnD), Annotations/Artifacts authoring, Schedules** → future milestones.
- **Native folder picker / arbitrary local filesystem access** → removed; workspaces come from the host's known roots.
- **macOS frameless-window chrome, multi-window, `-webkit-app-region` drag regions** → removed (N/A on mobile).
- **Direct on-device agent runtime, shell, git, MCP-stdio** → removed (runs on the host).

---

## [0.2.0] — v1 (planned)
- Session search; read-only file browser + file viewer; CI/PR status; requirements management.
- Branch checkout from the composer; richer commit flows.
- Detox e2e for the core loop.

## [Future]
- Annotations, Artifacts (sandboxed preview), Schedules, Worktrees.
- Track board (tap-to-move), sprints, members.
- Lightweight in-app code editor (Monaco replacement) and optional remote terminal.

---

*See [roadmap.md](docs/roadmap.md) for milestone rationale and sequencing.*

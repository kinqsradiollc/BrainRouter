# Changelog — BrainRouter Mobile

All notable changes to the **mobile** app. Format: [Keep a Changelog](https://keepachangelog.com/). This starter log documents the **desktop → mobile** transition: what's **Added** (mobile-native), **Adapted** (reshaped from desktop), **Removed/Deferred** (desktop-only), and the **Architecture** shift. Updated as Phase 3 features land.

> Companion to the repo-root `CHANGELOG.md` (desktop/CLI/core). Versions track the desktop `0.4.x` line.

---

## [Unreleased] — Phase 2 planning complete

Planning & design artifacts produced (no app code yet): investigation summary, UI spec, user stories, user flows, UX enhancements, technical doc, workflows, roadmap, and HTML prototypes. Awaiting approval to begin Phase 3.

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

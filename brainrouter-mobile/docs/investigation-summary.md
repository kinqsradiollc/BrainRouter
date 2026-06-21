# Phase 1 — Desktop App Investigation Summary

> **Source of truth** for the BrainRouter desktop → React Native (Expo) mobile port.
> Audit of `brainrouter-desktop/` (Electron ^33 + React 18 + Vite, ~16K LOC / 142 source files), 2026-06-22.
> Everything in Phase 2/3 is grounded in this document. File citations use `path:line` relative to the repo root.

---

## 0. TL;DR — the one thing that shapes the whole port

The desktop app is a **thin React UI over a Node-only agent runtime**. The React renderer never imports Electron or Node; it reaches *every* capability through a single preload bridge `window.brainrouter` (`brainrouter-desktop/src/bridge.d.ts`). The actual agent engine — `@kinqs/brainrouter-core` — runs in an Electron `utilityProcess`, one per workspace (`brainrouter-desktop/electron/main.ts:142`), and is **Node-only** (`child_process`, `fs`, streaming `fetch`, stdio MCP).

**Consequences for mobile:**

1. **The runtime cannot run on-device.** React Native (Hermes/JSC) has no `child_process`/`fs`/Node module system, and the agent's whole purpose — editing files and running builds/tests in a workspace on disk — has no on-device analogue on a phone.
2. **The mobile app must be a thin client to a remote host** running `brainrouter-core` (a developer's desktop, the CLI machine, or a server/WSL box), over WebSocket/SSE/HTTP.
3. **The hard part is already done.** The wire vocabulary `@kinqs/brainrouter-agent-protocol` is explicitly transport-agnostic (envelopes carry a `seq` for "gap detection over lossy transports" — `packages/agent-protocol/src/index.ts:18-25`) and has **zero runtime deps** (RN-safe). `brainrouter-desktop/src/devBridge.ts` *already* reimplements the entire bridge as a non-Electron mock — proving the renderer is a swappable transport client.
4. **One net-new backend component is required:** a small WebSocket/SSE server that wraps the existing, deliberately Electron-free `createHostCore` router (`brainrouter-desktop/electron/hostCore.ts`) and swaps the transport from Electron `parentPort` to a socket. `createHostCore` already takes injected `send`/`handle`/`spawnAgent`, so this is a transport adapter, **not** a rewrite of agent logic.

> **Precedent that remoting is a first-class idea here:** the separate memory MCP server (`brainrouter/`, `@kinqs/brainrouter-mcp-server`) already runs over **HTTP on port 3747** (Express + Streamable HTTP MCP, `brainrouter/src/index.ts:88-89,286`; a live deployment runs it in WSL), and `brainrouter-core` is itself an HTTP MCP *client* with `remote`/`*.brainrouter.cloud` profiles (`packages/core/src/mcp/mcpClient.ts:234-255,419-437`). The team already operates a remote-server posture for memory; extending the same shape to the agent host is the natural path.

```
 CURRENT (desktop)                              PROPOSED (mobile)
 ┌────────────────────────┐                     ┌────────────────────────┐
 │ React renderer (SPA)   │                     │ React Native (Expo)    │
 │  window.brainrouter ───┼── Electron IPC ──┐  │  remote bridge ────────┼─ WS/SSE ─┐
 └────────────────────────┘                  │  └────────────────────────┘          │
 ┌────────────────────────┐                  │                                      │
 │ Electron main          │                  │   (no Node/Electron on device)       │
 │  utilityProcess.fork ──┼──► host.js ◄─────┘                                      │
 └────────────────────────┘      │                                                  ▼
                                  ▼                         ┌──────────────────────────────────┐
                       @kinqs/brainrouter-core              │ brainrouter-host (NET-NEW)         │
                       (Agent, MCP, fs, child_process)      │  WS/SSE server wrapping            │
                                                            │  createHostCore + brainrouter-core │
                                                            │  runs where the workspace lives    │
                                                            └──────────────────────────────────┘
```

---

## 1. What the app is

BrainRouter Desktop is an **agentic coding IDE / AI chat shell** — "a native macOS/Windows shell (Electron + React) over the shared `@kinqs/brainrouter-core` agent runtime (the same engine the CLI uses)" (`brainrouter-desktop/package.json:5`). A developer opens a workspace (a git checkout), chats with an AI agent that can read/edit files and run shell/git/tests, and reviews/approves the agent's work through a rich set of panels (plan, diff, review, requirements, terminal, CI, background tasks, etc.).

It is a **single-window SPA** (no router). The whole UI mounts `<App/>` from `src/main.tsx:6`; navigation is state-driven inside `src/App.tsx` (~1224 lines).

---

## 2. Screens, views & modes

The app has **three top-level "modes"** (one state: `mode: 'chat' | 'track' | 'code'`, default `'code'`, switched from the left sidebar segmented control — `App.tsx:134`, `1090-1158`) plus modal/overlay surfaces.

| Mode / surface | What it is | Notes |
|---|---|---|
| **Code** (default) | Full agentic-coding workbench: ChatThread + Composer + Environment column + resizable ViewsRail (panels) + bottom Terminal dock (`App.tsx:1134-1157`) | The only mode with panels/terminal/env. |
| **Chat** | Focused, **read-only** conversational stance — agent can read/search/reason but not edit or run shell; access pinned to `'read'` on entry (`App.tsx:256-261`) | Chat + composer only; read-only banner offers a switch to Code. |
| **Track** | Full-surface project-management board (`<TrackView>` replaces the main area, `App.tsx:1091`) | Kanban board / sprints / list / members / automations / reports. |
| **Home** | Empty-state *within* the chat surface when no conversation is active (`homeMode`) | Greeting + stats card + contribution heatmap + "pick up where you left off" recents. |
| **Task / Workflow transcript** | Read-only sub-agent/background-task transcript or a workflow card, opened *over* the chat with a breadcrumb back-link (`App.tsx:489-514,1097-1098`) | — |
| **Overlays** (mode-independent) | Command palette (`⌘K`), Settings modal, dialogs (export, per-chat context menu, interaction/trust prompts, info/review-gate) — `App.tsx:1177-1220` | — |

---

## 3. The 18 docked panels

Panels open as **tabs** in the resizable side column (ViewsRail) or bottom dock. Registry: `PANEL_DEFS` in `panels/Panel.tsx:14-33`; body dispatched by `renderPanelBody` (`App.tsx:903-1061`).

| Panel | Purpose | Mobile relevance |
|---|---|---|
| **Context** (`ContextPanel.tsx`) | Live token/context-window readout, savings, env | High — simple, informational |
| **Files** (`FilesPanel.tsx`) | VS Code-style folder tree from git file list; `?text` flips to content grep | Medium — read-only browse on mobile |
| **File** (`FileViewerPanel.tsx`) | Read-only syntax-highlighted single file (legacy, hidden) | Medium |
| **Editor** (`EditorPanel.tsx`) | In-app **Monaco** editor: dirty tabs, split, minimap, ⌘-chords | **Low/deferred** — Monaco is desktop-only |
| **Changes** (`DiffPanel.tsx`) | Working-tree file list + unified diff + commit/push/pull (review-gated) | High (read) / Medium (commit) |
| **Terminal** (`TerminalPanel.tsx`) | Real host-side **xterm** shell, polled 200ms | **Low/deferred** — xterm + shell are desktop-only |
| **Tool calls** (`ToolsPanel.tsx`) | Reverse-chron log of the session's tool runs | High — trivial list |
| **Background tasks** (`TasksPanel.tsx`) | Active-workspace background tasks/agents (live + finished) | High |
| **Dashboard** (`DashboardPanel.tsx`) | Cross-workspace task dashboard, 6 tabs, scope toggle | High |
| **Plan** (`PlanPanel.tsx`) | Agent's live plan checklist + plan-review + version history | High |
| **Search session** (`SearchPanel.tsx`) | Search persisted transcript (`/find`) | High — already mobile-friendly |
| **Schedules** (`SchedulePanel.tsx`) | Cron/once jobs firing slash commands | Medium |
| **Worktrees** (`WorktreesPanel.tsx`) | Sibling `.worktrees/` checkouts: list/create/open/diff/remove | **Low/deferred** — desktop git concept |
| **Review** (`ReviewPanel.tsx`) | PR-style local code review grouped by file; ~11 actions/finding | High (read+act) |
| **Requirements** (`RequirementsPanel.tsx`) | Per-workspace Requirement Records (status/priority/criteria/Q&A) | Medium |
| **Annotations** (`AnnotationsPanel.tsx`) | Durable feedback records anchored to plan/req/file/diff; export to chat | Medium |
| **Artifacts** (`ArtifactsPanel.tsx`) | Durable workflow outputs (md/HTML/SVG); preview, edit, versions | Medium |
| **CI / Checks** (`CIPanel.tsx`) | GitHub CI: PR header, check rollup, recent Actions runs | Medium |

Shared renderers: `panels/code.tsx` (`CodeBlock` via lazy Prism), `panels/diff.tsx` (`parseUnifiedDiff` + `DiffView`).

---

## 4. Components, layout & navigation

**Information architecture** (`App.tsx:1076-1221`):

```
.app (flex row)
├── Sidebar (.rail)              left column: mode switch + projects/sessions list
└── .main (flex col)
    ├── [track mode] TrackView   (replaces everything below)
    ├── .workrow (flex row)
    │   ├── ChatThread (.center)     breadcrumb + transcript + composer
    │   ├── EnvironmentPanel (.env-col) [code]  316px non-overlay column (git/branch/CI/tools/tasks)
    │   └── ViewsRail (.views-rail)  [code]  resizable tabbed panel column
    ├── TerminalDock (.term-dock)    [code]  resizable bottom dock
    └── TopbarRight (.topbar-right)  absolute pinned control cluster
```

**Key components:**
- **Sidebar** (`components/Sidebar.tsx`) — mode switcher (Chat·Code·Track), New chat, Projects list (drag-reorder, expand/collapse, pagination, archived toggle), Add project, account row, drag-to-resize grip. Session rows carry pin/fork/status, ⌘1–9 hint, age, ⋮ menu.
- **Composer** (`components/Composer.tsx`) — auto-growing textarea + drop zone + attachment chips + send/stop; slash-command popup (keyboard-nav); four inline popover menus (Mode Plan/Accept/Auto, Branch, Effort, Model w/ capability badges); ContextRing + usage popover.
- **ChatThread** (`components/ChatThread.tsx`) — breadcrumb header, scrolling transcript, live streaming row w/ caret, "working…" line (spinner + elapsed + reasoning tail), **inline approval card** (Ctrl/Cmd+Enter approve; Deny/Always/Once), "↓ Latest" jump button, ChangeSummary bar, slots for Home/forked-banner/WorkflowCard/task transcript.
- **TopbarRight** (`components/TopbarRight.tsx`) — toggles: Environment, Add view (+ popover), full-screen, terminal dock, side panel, Export, Settings.
- **EnvironmentPanel** (`components/EnvironmentPanel.tsx`) — non-overlay 316px column: git changes, branch switch, commit/push, CI status, last-turn tool health, running tasks.
- **TerminalDock** (`components/TerminalDock.tsx`) — bottom dock hosting terminal/panel tabs.
- **Dialogs** — `InteractionDialogs` (agent multiple-choice question modal + workspace-trust prompt), `ExportAndMenuDialogs` (export session + per-chat ⋮ context menu w/ nested flyouts), `InfoAndGateDialogs` (info + review-gate block dialog + completion toast).
- **Primitives** — `UsageBar`, `ContextRing` (16px SVG arc), `GoalBanner` (sticky `/goal` banner), `HomeView`, `SessionStatus`, `WorkElapsed`, `Badge`/`Chip`, `Button` (class-composed variants via `lib/ui/controlClass.ts`), `icons.tsx` (~dozens of hand-rolled 16px line-SVGs → trivially `react-native-svg`).

**Navigation mechanics:** modes via sidebar; panels via `ensurePanel`/`togglePanel`/`openSideView` (state in `lib/panels/usePanels.ts`); command palette (`palette.tsx:88`, ⌘K, fuzzy, arrow/enter); Settings two-pane modal (`settings.tsx`, 13 categories). **Keyboard shortcuts** are pervasive: ⌘K, ⌘,, ⇧⌘D/F/G/E, Ctrl+\`, ⌘1–9, Ctrl/Cmd+Enter approve, plus Monaco ⌘-chords.

---

## 5. State management & data models

**No Redux/MobX/Zustand and no React Context.** All state is `useState`/`useRef` lifted into `App.tsx` and threaded into ~10 custom hooks via large typed context objects. **Refs mirror state** everywhere (`sessionsRef`, `activeWsRef`, …) so the mount-once event listener reads live values without stale closures — a portable pattern.

**Key hooks/stores:**

| Hook | Owns | Portability |
|---|---|---|
| `useSessionState` (`lib/session/useSessionState.ts:76`) | Core container: viewed session, running/stopping flags, cross-session running set, sidebar sessions + optimistic rows, live children, workspaces, expanded projects, trust prompt | Pure container — portable |
| `useSessionSidebar` (`lib/session/useSessionSidebar.ts:31`) | **Pure derived** (filter archived, pins-first sort, grouped chats, visible window) | Fully portable |
| `useSessionActions` (`lib/session/useSessionActions.ts:142`) | Imperative handlers: refresh/resume/switchWorkspace/openProject/toggleProject/openTask/menu actions/answerInteraction/requestStop | Bridge-coupled → transport-parameterize |
| `useAgentEvents` (`lib/agent/useAgentEvents.ts:181`) | **The event bus**: single `onEvent` subscription + ~450-line `handleQueryResult` router — the entire inbound data path; throttles streaming deltas ~16×/s | **#1 thing to abstract behind a transport interface**; routing logic is portable |
| `usePanels` (`lib/panels/usePanels.ts:46`) | Side-panel tabs + bottom dock; persists layout to localStorage | Logic salvageable, layout = desktop |
| `useGitState` (`lib/git/useGitState.ts:67`) | Changed files, diffs, git info, worktrees, per-workspace review maps; `runGit` (commit/push, review-gated) | Bridge-coupled |
| `useEditor` (`lib/editor/useEditor.ts:31`) | Monaco tab state; self-contained `ed:` host round-trips | `editorModel` portable; Monaco not |
| `useCi` (`lib/ci/useCi.ts:38`) | GitHub CI/PR/runs/logs; polls watched run every 5s | Bridge-coupled |
| `useComposerDerived` (`lib/composer/useComposerDerived.ts:38`) | **Pure derived**: title, homeMode, slash state, mode/effort/model labels | Fully portable |
| `expandedProjectsStore` (`lib/session/expandedProjectsStore.ts`) | Module-level localStorage for sidebar expansion | Swap storage adapter |

**Global singleton:** `window.brainrouter` (the bridge) is the de-facto global. There are **three independent `onEvent` subscriptions** (useAgentEvents, useEditor, useCi). `rid()` (`lib/rid.ts`) is a monotonic local-id counter.

**Core data models:**
- Renderer-local (`src/types.ts`): `ChatRow` (discriminated union: user/assistant/status/error/cmd-out/loading/briefing/changeset/tool-group — the transcript atom), `ToolItem`, `PlanItem`, `SessionRow` (sidebar chat), `FleetRow` (background task), `TaskViewState`, `WorkflowDetail`/`WorkflowPhase`/`WorkflowAgent`, `AttachmentUpload`, `BriefingRecord`, `ChangesetFile`.
- Domain records (from `@kinqs/brainrouter-types`): Track domain (`TrackProject`, `WorkItem`, `Sprint`, `AutomationRule`, `ProjectMember`/`ProjectRole`/`ProjectCapability`), `RequirementRecord`, `AnnotationRecord`, `ArtifactRecord`, plus local view types (`ScheduleRecordView`, `PlanDecisionView`, `WorktreeEntry`, `EditorTab`, CI `CheckRow`/`RunRow`/`PrDetail`).
- Permissions: `ROLE_RANK` + `CAPABILITY_MIN_RANK` (`lib/track/permissions.ts`), pure rank comparison.

**Persistence:** localStorage only (~30 `br-*` keys: UI prefs, panel layout, editor prefs, sidebar expansion). All **durable** data (sessions/transcripts, metadata, requirements/annotations/artifacts/schedules, plan history, trust, recents) lives **host-side** and is treated as server-fetched state, refetched on session/workspace switch and after each turn. → On mobile, localStorage becomes `AsyncStorage`/MMKV; durable data comes from the remote host.

---

## 6. Business logic — portable vs desktop-bound

**Highly portable (pure TS, no React/DOM/bridge) — port verbatim:**
- **All `*View.ts` view-models** (the most portable assets in the codebase): `planReviewView`, `requirementsView`, `annotationsView`, `artifactsView`, `scheduleView`, `reviewWorkspace`, `reviewGateUi`, `reviewCode` (unified-diff → styled rows), `projectSessionsView`, `sessionDisplay`, `editorView`.
- **Pure parsers/logic:** `lib/track/query.ts` (a full JQL-style tokenizer + recursive-descent parser, ~180 lines), `lib/track/permissions.ts` (RBAC), `lib/worktree/worktreeParser.ts`, `lib/editor/editorModel.ts` (tab state machine), `lib/chat/thinkParse.ts` (`<think>` extraction), `lib/chat/toolVisual.ts`, `lib/composer/slashHighlight.ts`, `lib/attachments/attachmentPrompt.ts`, `lib/models/modelCapabilities.ts`, `lib/ci/ciFormat.ts`, `lib/git/gitFreshness.ts`, `lib/panels/sideRailLayout.ts`, `lib/ui/controlClass.ts`, `lib/rid.ts`.
- **Pure session/workspace logic:** `sessionOrder`, `sessionPagination`, `sessionCache`, `taskTranscriptRouting`, and crucially **`workspace/workspaceEvents.ts`** (multi-workspace event routing + generation-stamping — transport-agnostic, central to correctness), `workspace/dashboard.ts`, `workspace/runningIndicators.ts`.
- `format.ts` (ages/rel/tokens) **except** `download()` which uses DOM (`format.ts:69` → RN share/save).
- Command core `commands.ts` (`buildCommandList`/`resolveSlashInput`/`runCommand`) — though `panel`/`settings` wires target desktop concepts.

**Desktop-bound (needs rethink):** `usePanels` multi-column layout; `useEditor` + Monaco; git/worktree/terminal features (assume local checkout + shell); file-path assumptions (split on `/`/`\`); `devFlags.ts` (`window.location`); localStorage.

**Bridge-coupled (needs the remote transport):** `useAgentEvents` (abstract first), `useSessionActions`, `useEditor`, `useCi`, `useGitState`, plus scattered `send`/`trustWorkspace`/`globalDashboard` calls.

**Recommended port seam:** introduce two interfaces — `BrainRouterTransport` (wraps `send`/`onEvent` + the promise methods) and `Storage` (wraps localStorage) — injected where code reaches `window.brainrouter`/`localStorage` today. Pure hooks + all `*View.ts`/parsers move unchanged; the bridge-coupled hooks become transport-parameterized; only `usePanels`, Monaco, and terminal/worktree need genuine redesign.

---

## 7. The Electron / Node layer

### Main process (`electron/main.ts`)
- App lifecycle, one **`BrowserWindow` per workspace** (1280×840, `hiddenInset` titlebar on macOS), **multi-window** map (`main.ts:54,222-225`).
- Per-window security: `setWindowOpenHandler` deny-all, `will-navigate` gated by pure `isAllowedNavigation` (`windowSecurity.ts`), `contextIsolation:true` + `nodeIntegration:false` + typed-preload-only + `senderFrame` validation.
- Native folder picker via `dialog.showOpenDialog` (`main.ts:294`) — the only OS dialog. No app Menu/Tray/protocol/global-shortcuts/auto-updater in these files.
- Owns the **host pool**: `utilityProcess.fork('host.js', …)` per workspace (`main.ts:142-175`); host→renderer events tagged with `workspaceRoot` and forwarded via `webContents.send('agent-event', …)`; renderer→host via `ipcMain.on('agent-command')` → `host.postMessage`.
- Pool lifecycle is pure & unit-tested (`hostPoolPolicy.ts`): switching workspace only changes the active host; idle non-active hosts reaped after a 5-min TTL, never while running.

### Preload bridge — the renderer↔main contract (`preload.cts` / `bridge.d.ts`)
One object `window.brainrouter` via `contextBridge`, with two layers:

**Layer 1 — direct methods (13):**
- Agent channel: `send(AgentCommand)`, `onEvent(listener) → unsub`, `onRecentsChanged(listener)`.
- Workspace mgmt (invoke → `ipcMain.handle`): `addWorkspace()` (folder picker), `workspaceRecents()`, `workspaceSessions(root, limit?)`, `openWorkspace(root)`, `isWorkspaceTrusted(root)`, `trustWorkspace(root)`, `untrustWorkspace(root)`, `trustedWorkspaces()`, `markActivity(root, reason)`, `reorderWorkspace(dragged, target)`, `globalDashboard()`.

**Layer 2 — the `query`/`query-result` sub-protocol (~140 named handlers in `host.ts:1045-2731`)** — the real feature API. Grouped:
- **Sessions/transcripts:** `list-sessions`, `workspace-sessions`, `session-info`, `recap`, `transcript`, `task-transcript`, `search-transcript`, `search-content`, `chapters`, `export-chat`, `action:session-meta/-delete/-fork/-groups`.
- **Filesystem/editor:** `list-files`, `read-file`/`file-read`, `file-stat`, `action:file-save`, `file-diff`, `changed-files`, `turn-changeset` (all via `fsRead.ts`, workspace-relative, symlink-hardened).
- **Git/GitHub (shell out):** `git-branches/-log/-info/-pr/-pr-detail/-pr-checks`, `git-actions-runs/-run-detail/-run-log`, `action:git-actions-rerun-failed`, `git-worktrees`, `worktree-diff/-create/-remove`.
- **Terminal (child-process shells):** `term-open/-write/-read/-kill`, `action:term-exec`.
- **Agent/model/config:** `set-model`, `list-models` (live provider fetch), `config-snapshot`, `action:set-llm/-cli-json/-cli-knob/-provider/...`, `action:set-agent-model/-pref/-session-mode/-access/-clear/-compact`, `context-usage`, `usage-breakdown`, `commands-catalog`.
- **MCP / Extensions:** `action:reconnect-mcp/-add-mcp/-remove-mcp`, `extensions`, `action:ext-set-enabled`.
- **Review:** `review-diff/-rerun/-current/-status/-gate/-dismiss/-resolve/-set-finding-status/-apply-suggestion/-fix-finding`.
- **Plan/Goal/Requirements/Annotations/Artifacts/Track/Schedule/Attachments:** `plan-state/-history/-record-decision`, `goal-state/-continuation`, `requirement-*`, `annotation-*`, `artifact-*`, `track-*`, `schedule-*`, `attachment-ingest/-list/-read/-context`.
- **Background tasks:** `fleet`, `tasks-list`, `task-detail`, `workflow-detail`, `home-stats`.
- **Permissions/external:** `action:allow-rule/-rule-edit/-set-track-github/-set-hook/-open-external`.

> **`devBridge.ts` already mocks this entire surface in-memory** (`src/devBridge.ts:11-12`), installing `window.brainrouter` whenever the real preload is absent. This is the strongest evidence the renderer is cleanly decoupled — the mobile remote bridge slots in exactly where `devBridge`/`preload` do.

### The agent-protocol (`@kinqs/brainrouter-agent-protocol`)
Transport-agnostic vocabulary (consumed by the Ink TUI as callbacks, the CLI as JSONL, the Desktop over IPC). Zero runtime deps.
- **EventEnvelope:** `{ seq, ts, sessionKey }` — monotonic per-session seq for gap detection over lossy transports.
- **AgentEvent (host→UI, ~30 kinds):** `turn-start`, `status`, `assistant-turn-start/delta/end`, `reasoning-delta`, `tool-start/end`, child events, `plan-update`, `compaction`, `memory`, record-lifecycle events (`requirement-`/`artifact-`/`annotation-event`, `provenance`, `task-event`), `approval-decision`, `interaction-request`, `turn-complete`, `turn-error`, `tokens-updated`, `usage-live`, `session-changed`, `query-result`, `notice`, `files-changed`.
- **AgentCommand (UI→host):** `start-turn`, `interrupt`, `interaction-response`, `query`, `new-session`, `resume-session`, `set-model`, `shutdown`.
- **Interaction port:** `InteractionBroker` correlates `confirm`/`choice` approval requests with responses; fail-closed 5-min timeout → `dismissed`.

### Host / runtime bridge (`host.ts`, `hostCore.ts`, `hostPoolPolicy.ts`, `sessionModeBridge.ts`)
Host boots "exactly like `brainrouter chat`": `loadConfig()` (reads `~/.config/brainrouter/config.json`), `McpClientPool.connectAll`, `loadExtensions`, `new Agent(...)` (`host.ts:484-510`). `hostCore.ts` keeps a **pool of `Agent` instances keyed by sessionKey** so multiple chats run turns simultaneously. Events streamed via `hostCore.stamp(sessionKey, event)` → `parentPort.postMessage`. **`hostCore.ts` is deliberately Electron-free and unit-tested** (`createHostCore` takes injected `send`/`handle`/`spawnAgent`) — this is the exact seam a network host shim reuses.

### Filesystem & watching
`fsRead.ts` (safe workspace read/write/list/stat, symlink-hardened, 200KB cap), `fileWatch.ts` (`fs.watch({recursive})` + 300ms debounce → `files-changed`; degrades to git-poll on Linux), `workspaceFileListCache.ts` (30s TTL), `recents.ts` (pure ordering, persisted by main to `userData/recent-workspaces.json`).

---

## 8. Data layer — runtime, backend, config, memory

- **Agent runtime (`@kinqs/brainrouter-core`):** the headless engine shared verbatim by CLI and Desktop. **Node-only, unambiguously:** streams LLM completions via `fetch` + `res.body.getReader()` to OpenAI-compatible `/chat/completions` (`packages/core/src/agent/agent.ts:5772-5822`, `Authorization: Bearer`); `child_process` for shell/git/tests (`agent.ts:3`, exec sandbox in `packages/core/src/exec/*`); `node:fs`/`path`/`os`/`crypto` pervasive; all durable state file-backed. No native addons in core itself.
- **Backend / network:** there is **no network backend for the agent** today — it runs in-process in the `utilityProcess`. The only outbound network from the runtime is to **LLM providers** (Anthropic reached via an OpenAI-compatible gateway — OpenRouter/LiteLLM/shim — `brainrouter-docs/configuration.md:150-167`) plus a 5s `GET /models` probe. Keys live in `~/.config/brainrouter/config.json`, never in code.
- **Port-3747 server is a *separate* component** — the cognitive-memory MCP server (`brainrouter/`), Express + Streamable HTTP MCP + SQLite (`memory.db`, FTS5 + `sqlite-vec`), reached by the desktop only as an MCP *client* (offline-tolerant). Not the agent loop.
- **Existing remoteability:** `brainrouter-core` is already an HTTP MCP *client* (`StreamableHTTPClientTransport`, `mcpClient.ts:234-255`) with `local-http → :3747/mcp` and `remote → https://…/mcp` Bearer profiles — but the **agent runtime has no server/host mode of its own** (grep for `listen(`/`createServer`/`express`/`WebSocketServer`/`--serve`/`daemon` in `packages/core` + `brainrouter-cli` → only the memory server matches). So the agent↔UI seam exists *as a typed protocol* but is only wired over in-process IPC.
- **Config & state roots:** config `~/.config/brainrouter/config.json` (shared CLI/desktop); user-global state `~/.brainrouter/` (`BRAINROUTER_HOME`) holds per-workspace `sessions/<key>/{transcript.jsonl, goal.json, tasks.json}`, prefs, hooks, background-task records, attachments, `memories/`; memory `~/.brainrouter/memory.db`. Workspace **trust** in the shared core store. Telemetry local-only (`~/.brainrouter/telemetry/events.jsonl`).

---

## 9. Dependency mapping (desktop → mobile)

| Desktop dep / capability | Where | Mobile mapping |
|---|---|---|
| **electron** (BrowserWindow, utilityProcess, IPC, preload) | `main.ts`, `preload.cts` | **Drop** — replaced by Expo shell + remote bridge |
| **`@kinqs/brainrouter-core`** (agent engine) | `host.ts:20-135` | **Move to remote host** — cannot run on device |
| **`@kinqs/brainrouter-agent-protocol`** | wire contract | **Keep verbatim** — RN-safe, zero deps; becomes the network protocol |
| **`@kinqs/brainrouter-types`** | domain types | **Keep verbatim** (avoid value-imports that pull `node:crypto`) |
| **monaco-editor / @monaco-editor/react** | Editor panel | **Replace/defer** — RN code view (e.g. `react-native-syntax-highlighter`) or WebView CodeMirror; no drop-in |
| **@xterm/xterm + addon-fit** | Terminal panel | **Drop (MVP)** — DOM canvas + host shell; optional remote-terminal view later |
| **react-markdown + remark-gfm** | Chat markdown | **Replace** with `react-native-markdown-display` |
| **react-syntax-highlighter** | Code blocks | **Replace** with `react-native-syntax-highlighter` (same Prism core) |
| **react** | UI logic | **Keep** (reuse presentation logic) |
| **react-dom / Vite** | Web render/build | **Replace** with React Native + Metro |
| Node `fs`/`path`/`os`/`child_process` | `fsRead.ts`, `host.ts`, core | **Move to host** — none belong in the client |
| `fs.watch` recursive watcher | `fileWatch.ts` | **Move to host** — host pushes `files-changed` over socket |
| `dialog.showOpenDialog` folder picker | `main.ts:294` | **Re-model** — pick workspace from the host's known roots; Expo `DocumentPicker` for attachments only |
| Multi-window (per-workspace BrowserWindow) | `main.ts:54` | **Drop** — single view + in-app workspace switcher |
| `windowSecurity.ts` navigation guards | `main.ts:248-252` | **Drop** — replace with TLS + auth token on the socket |
| localStorage (~30 `br-*` keys) | App/usePanels/editor | **Replace** with AsyncStorage/MMKV behind a `Storage` adapter |
| icons (`icons.tsx`, hand-rolled SVG) | — | **Keep** → `react-native-svg` |
| CSS variable design tokens (`theme.css`) | — | **Keep** → RN theme object |

---

## 10. Design tokens (from `src/theme.css`, dark theme)

Accent is user-overridable at runtime (`--accent`, `App.tsx:595-606`); theme via `data-theme` (dark / high-contrast `hc`). These map directly to an RN theme object.

- **Colors (dark):** `--bg: hsl(240 6% 5%)`, `--surface: hsl(240 5% 9%)`, `--sidebar: hsl(240 7% 4%)`, `--raised: hsl(240 5% 13%)`, `--input: hsl(240 6% 8%)`; borders `--border: hsl(240 5% 15%)` / `--border-strong: hsl(240 5% 21%)`; text `--text: hsl(0 0% 96%)` / `--text-dim: hsl(240 5% 72%)` / `--text-faint: hsl(240 4% 50%)`; **accent** `hsl(245 80% 66%)` (indigo) + `--accent-soft`; **brand** `hsl(16 65% 58%)` (warm orange); status `--ok hsl(142 60% 45%)`, `--warn hsl(38 85% 48%)`, `--err hsl(38 85% 50%)`; `--user-bubble hsl(240 5% 11%)`, `--term-bg hsl(240 8% 3%)`; a white-overlay interaction scale `--ov-025…--ov-26`.
- **Radii:** `--r-sm 9px`, `--r-md 14px`, `--r-lg 20px`.
- **Typography:** `--font` apple-system/Inter/Segoe; `--mono` SF Mono/Cascadia/JetBrains (user-overridable); base body 12.5px; chat width `--chat-w` (720/840/980) + size `--chat-fs` (13.5/14.5/15.5) runtime vars.

---

## 11. Mobile-port implications — desktop patterns that don't map to a phone

1. **Simultaneous multi-pane layout is the core model** (Sidebar + Chat + Env column + ViewsRail + Terminal dock at once). A phone shows one surface at a time → needs a stack/tab/drawer navigator; env column & panels become routes or bottom sheets; the toggle cluster collapses into an overflow.
2. **Drag-to-resize grips + swipe-to-hide** on three columns → no touch analogue; replace with fixed drawers/sheets.
3. **Monaco editor + xterm terminal** are the two heaviest desktop-only subsystems → RN replacements or omit on phone (MVP defers both).
4. **Drag-and-drop kanban** (Track) → tap-to-move / status-picker sheets.
5. **Dense multi-column tables/grids** (Track list, members matrix, diff two-column gutter, GFM tables) → responsive/stacked layouts.
6. **Hover-only affordances are pervasive and load-bearing** (message-row action strips, copy-on-hover, `title=` tooltips carrying exact values) → must become always-visible or tap/long-press.
7. **Right-click + nested-flyout menus** (per-chat ⋮ menu, Track dropdown) → action sheets / native pickers.
8. **Command palette + slash UX + the whole keyboard-shortcut layer** is keyboard-first → replace with explicit touch controls; keep slash commands via an in-composer picker.
9. **Wide modals** (Settings 980×660, palette 620px) → drilldown lists / full-screen search.
10. **`window.prompt()` for input** (editor/plan annotations) → custom input modals.
11. **Blur-to-save / modifier-key submit** (Track detail) → explicit Save buttons (mobile keyboards make blur unreliable).
12. **macOS frameless-window / traffic-light / `-webkit-app-region` chrome** → drops entirely on mobile.

**Genuinely portable as-is (presentational):** `UsageBar`, `ContextRing`, `SessionStatus`, `WorkElapsed`, `Badge`/`Chip`, `Button` (shape; reimplement variants as RN styles), the icon set, and the simpler list/form panels (Search, Tools, Tasks, Schedules, Context). The design-token system and runtime accent/theme overrides translate to RN context theming.

---

## 12. What this means for MVP-first scope (input to Phase 2 roadmap)

Because the agent runtime must be remote and the heavy IDE surfaces don't fit a phone, the natural **MVP is a "remote control for your coding agent"**: connect to a host, browse projects/sessions, watch the agent work (streaming chat + tool cards + plan + token/context), **approve/deny tool requests and review gates**, read diffs and review findings, and manage background tasks — i.e. the monitoring + approval + lightweight-review loop. The MVP also requires the **one net-new backend piece** (the WebSocket/SSE host bridge) to exist at all.

**Deferred to v1/future** (documented, not dropped): in-app code **editing** (Monaco replacement), **terminal**, **worktree** management, full **Track** kanban with DnD, requirements/annotations/artifacts authoring, schedules. Read-only or simplified versions of several of these may land earlier.

This scope split is detailed in `roadmap.md`; the dependency/transport architecture is detailed in `technical-doc.md`.

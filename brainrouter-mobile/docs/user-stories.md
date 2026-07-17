# User Stories — BrainRouter Mobile

> Format: *As a [user], I want to [action] so that [benefit].* Each story has a unique ID, acceptance criteria, the screens it touches ([ui-spec.md](ui-spec.md)), the flow it belongs to ([user-flows.md](user-flows.md)), and a milestone ([roadmap.md](roadmap.md)).
> **Single persona** (grounded in the desktop app): **Dev** — a developer who runs BrainRouter coding agents on a desktop/CLI/server **host** and wants to monitor, steer, and approve that work from a phone. No features are invented; every story maps to existing desktop functionality. Net-new mobile concerns (host pairing, push) are labelled.

Legend — Milestone: **MVP** · **v1** · **future**.

---

## Connection & onboarding

### US-01 · Pair with a host — *MVP*
As a Dev, I want to connect the app to my running BrainRouter host so that I can control my coding agent remotely from my phone.
**Acceptance:** can enter a host URL + token (or scan a pairing QR); a successful connect lands me on my projects; an invalid/unreachable host shows a clear error with Retry; the host+token are stored securely and reused next launch.
**Screens:** S-01, S-15 · **Flow:** UF-01 · *Net-new (replaces the desktop in-process host).*

### US-02 · Stay connected — *MVP*
As a Dev, I want the app to show connection status and reconnect automatically so that I trust what I'm seeing is live.
**Acceptance:** a persistent indicator shows Connected / Reconnecting / Offline; dropped sockets auto-reconnect with backoff; on reconnect, missed events are resynced via the protocol's `seq` gap-detection; stale data is visibly marked while offline.
**Screens:** S-15, global banner · **Flow:** UF-01 · *Uses `EventEnvelope.seq` (investigation §7).*

---

## Projects & sessions

### US-03 · Browse projects & sessions — *MVP*
As a Dev, I want to browse my projects and their chat sessions so that I can pick up work where I left off.
**Acceptance:** projects list with expandable session lists; each session shows status, title, age, turn count, pin/fork markers; pull-to-refresh; "show more"/archived expanders; running sessions show a live indicator.
**Screens:** S-02 · **Flow:** UF-02 · *Ports `Sidebar.tsx`/`projectSessionsView.ts`.*

### US-04 · Start a new chat — *MVP*
As a Dev, I want to start a new chat in a project so that I can kick off a new task.
**Acceptance:** "New chat" creates a session in the active workspace and opens the chat on the Home empty-state; first message becomes the title.
**Screens:** S-02 → S-03 · **Flow:** UF-13 · *`new-session`.*

### US-05 · Resume a session — *MVP*
As a Dev, I want to open an existing session so that I can continue the conversation with full history.
**Acceptance:** tapping a session loads its transcript (with a skeleton while resuming); scroll position starts at latest; errors offer Retry.
**Screens:** S-02 → S-03 · **Flow:** UF-02 · *`resume-session`/`transcript`.*

### US-06 · Manage a session — *MVP*
As a Dev, I want to pin, rename, fork, complete, archive, delete, or export a session so that I keep my workspace organized.
**Acceptance:** long-press (or ⋮) opens an action sheet with all actions; destructive actions confirm; export offers Markdown/JSON; changes reflect immediately (optimistic).
**Screens:** S-24 · **Flow:** UF-02 · *Ports `ExportAndMenuDialogs.tsx`; `action:session-meta/-fork/-delete`, `export-chat`.*

### US-07 · Switch workspace — *MVP*
As a Dev, I want to switch the active project/workspace so that I can work across multiple codebases.
**Acceptance:** a header switcher lists recents in order; selecting one re-scopes Chats/Activity/Review; opening an untrusted workspace prompts for trust first.
**Screens:** S-18 (→ S-19) · **Flow:** UF-10 · *`workspaceRecents`/`openWorkspace`/`isWorkspaceTrusted`.*

---

## The core agent loop

### US-08 · Send a turn — *MVP*
As a Dev, I want to send a message to the agent so that it works on my task.
**Acceptance:** composer sends on tap; input clears; my message appears immediately; send is disabled while empty; a slash-only input is routed locally, never to the LLM.
**Screens:** S-03 · **Flow:** UF-03 · *`start-turn`; `resolveSlashInput`.*

### US-09 · Watch live work — *MVP*
As a Dev, I want to watch the agent's response stream — text, reasoning, and tool calls — so that I know what it's doing in real time.
**Acceptance:** assistant text streams with a caret; reasoning shows as a collapsible block; tool calls render as cards with verb/icon/summary/ok-fail; a "working…" line shows elapsed time; a "↓ Latest" button appears when scrolled up.
**Screens:** S-03, S-08 · **Flow:** UF-03 · *Ports `ChatThread.tsx` + `useAgentEvents` over the remote transport.*

### US-10 · Interrupt the agent — *MVP*
As a Dev, I want to stop the agent mid-turn so that I can correct course.
**Acceptance:** a Stop control is visible while running; tapping it interrupts the turn and shows an interrupted state; I can then send a new message.
**Screens:** S-03 · **Flow:** UF-03 · *`interrupt`.*

### US-11 · Review & approve the plan — *MVP*
As a Dev, I want to see the agent's plan and approve it or request changes so that I stay in control of the approach.
**Acceptance:** plan items show status + acceptance; I can approve or request changes with feedback; requesting changes launches a revision; plan version history is viewable.
**Screens:** S-06 · **Flow:** UF-04 · *Ports `PlanPanel.tsx`; `plan-state`/`plan-record-decision`.*

### US-12 · Approve or deny a tool action — *MVP*
As a Dev, I want to approve or deny a tool the agent wants to run so that it only does what I allow.
**Acceptance:** an approval surfaces (banner + sheet) with the tool/command/diff preview; I can Allow once, Always allow, or Deny; the decision is sent back; if I don't respond within the timeout, it fails closed (denied).
**Screens:** S-05 · **Flow:** UF-03 · *Ports the inline approval card + `InteractionBroker` (5-min fail-closed).*

### US-13 · Answer the agent's question — *MVP*
As a Dev, I want to answer the agent's multiple-choice question so that it can proceed.
**Acceptance:** a question sheet shows single- or multi-select options; Submit sends the response; Esc/dismiss is treated per the broker's rules.
**Screens:** S-05 · **Flow:** UF-05 · *Ports `InteractionDialogs.tsx` question modal; `interaction-response`.*

### US-14 · Tune mode, model & effort — *MVP*
As a Dev, I want to set the agent mode (Plan/Accept/Auto), model, and effort so that I control how it behaves.
**Acceptance:** composer pills open sheets; mode/model/effort changes apply to the chat (model scope: this chat / all chats); model list shows capability badges; selection is reflected in the pills.
**Screens:** S-04 · **Flow:** UF-03 · *Ports `Composer.tsx` menus; `set-session-mode`/`set-model`.*

### US-15 · Run a slash command — *MVP*
As a Dev, I want to use slash commands so that I can trigger workflows and actions.
**Acceptance:** typing `/` opens a filtered command picker from the live catalog; selecting runs the command (native/panel/cli wire); a slash command is never sent as a chat message.
**Screens:** S-03 · **Flow:** UF-03 · *Ports `commands.ts`/`commands-catalog`.*

### US-16 · Attach context — *MVP*
As a Dev, I want to attach an image or document to my message so that the agent has the context it needs.
**Acceptance:** ＋ opens the device picker; attachments show as chips with read/attaching/attached/failed status; the prompt is built with attachment context; failed attachments can be removed/retried.
**Screens:** S-03 · **Flow:** UF-03 · *Ports `attachmentPrompt.ts`; `attachment-ingest`. Expo `DocumentPicker`/`ImagePicker`.*

### US-17 · Set and track a goal — *MVP*
As a Dev, I want to set a `/goal` and see it pinned so that the agent stays on a long-running objective.
**Acceptance:** an active goal shows a sticky banner with edit/pause/resume/delete; goal continuation is reflected across turns.
**Screens:** S-03 · **Flow:** UF-13 · *Ports `GoalBanner.tsx`; `goal-state`/`action:goal-edit`.*

---

## Review, changes & quality

### US-18 · Review changes & read diffs — *MVP*
As a Dev, I want to see the working-tree changes and read per-file diffs so that I can review the agent's edits.
**Acceptance:** changed-files list with +/− counts and status; tap → unified diff (read); branch shown; clean tree shows an empty state.
**Screens:** S-07 · **Flow:** UF-06 · *Ports `DiffPanel.tsx`; `changed-files`/`file-diff`.*

### US-19 · Commit & push from my phone — *MVP*
As a Dev, I want to commit and push the agent's work (respecting the review gate) so that I can ship without my laptop.
**Acceptance:** commit message input + Commit/Push/Pull; if the review gate blocks, I'm shown the gate sheet with options; successful actions update status.
**Screens:** S-07 (→ S-13) · **Flow:** UF-06 · *`runGit` commit/push, review-gated.*

### US-20 · Run review & triage findings — *MVP*
As a Dev, I want to run a code review and act on findings so that quality stays high.
**Acceptance:** Run/Re-run review; findings grouped by file with severity/confidence; per finding I can apply/ask-fix/resolve/dismiss/acknowledge/dispute/out-of-scope; status reflects (`reviewBadgeFor`).
**Screens:** S-11, S-12 · **Flow:** UF-07 · *Ports `ReviewPanel.tsx`; `review-*`.*

### US-21 · Be protected by the review gate — *MVP*
As a Dev, I want commit/push to be refused until review is clean so that I don't accidentally ship risky changes.
**Acceptance:** when blocked, a gate sheet explains and offers Run review / Open review / Commit-without-review (bypass) / Cancel.
**Screens:** S-13 · **Flow:** UF-06 · *Ports `InfoAndGateDialogs.tsx` review gate.*

---

## Monitoring & background work

### US-22 · Monitor background tasks — *MVP*
As a Dev, I want to see all running/finished/failed background tasks across workspaces so that I know what's happening.
**Acceptance:** scope toggle (this/all); tabs Running/Finished/Failed/Workflows/Agents/Bash with counts; rows show kind/label/status/phase/elapsed; review-gate badge per workspace; pull-to-refresh.
**Screens:** S-10 · **Flow:** UF-08 · *Ports `DashboardPanel.tsx`; `globalDashboard`/`fleet`.*

### US-23 · Inspect a task/workflow transcript — *MVP*
As a Dev, I want to open a background task or workflow to read its transcript so that I can inspect sub-agent work.
**Acceptance:** task header (kind/label/status/phase/elapsed) + read-only transcript; workflows show phases + per-agent token breakdown.
**Screens:** S-09 · **Flow:** UF-09 · *`task-transcript`/`workflow-detail`.*

### US-24 · Stop a runaway task — *MVP*
As a Dev, I want to stop a background task so that I control compute and cost.
**Acceptance:** a Stop button on each running row interrupts it; the row moves to finished/interrupted.
**Screens:** S-10 · **Flow:** UF-08 · *`interrupt`.*

### US-25 · Be notified when I'm needed — *MVP*
As a Dev, I want a push notification when the agent needs my approval or finishes a turn so that I can respond promptly while the app is backgrounded.
**Acceptance:** approval requests and turn-complete/error generate a notification (when enabled); tapping deep-links to the approval sheet or session; notifications respect a per-event toggle.
**Screens:** S-05 (deep link) · **Flow:** UF-12 · *Net-new mobile affordance over `interaction-request`/`turn-complete` events; see [ux-enhancements.md](ux-enhancements.md).*

### US-26 · Track token & context usage — *MVP*
As a Dev, I want to see token and context-window usage so that I manage context and cost.
**Acceptance:** the chat header shows a context ring; tapping opens a breakdown with the auto-compact marker, savings, and env (model/branch/session).
**Screens:** S-23 · **Flow:** UF-03 · *Ports `ContextPanel.tsx`; `context-usage`/`usage-breakdown`.*

---

## Settings

### US-27 · Choose model & provider — *MVP*
As a Dev, I want to pick my chat model and manage providers so that I use the right LLM.
**Acceptance:** active model + capability badges; provider add/remove/default; model picker (shared with composer); provider fetch errors are surfaced.
**Screens:** S-16 · **Flow:** UF-11 · *Ports `settings.tsx` Models; `list-models`/`action:set-llm`/`-provider`.*

### US-28 · Customize appearance — *MVP*
As a Dev, I want to set theme, accent, and code font/size so that the app fits my taste.
**Acceptance:** Dark / High-contrast; accent color; code font; chat text size; applies immediately and persists.
**Screens:** S-17 · **Flow:** — · *Ports `App.tsx` theme/accent/font prefs.*

### US-29 · Trust a workspace — *MVP*
As a Dev, I want to confirm I trust a folder before the agent acts in it so that I control access.
**Acceptance:** opening an untrusted workspace prompts Trust/Cancel; trusting is remembered host-side; canceling aborts the open.
**Screens:** S-19 · **Flow:** UF-10 · *Ports trust prompt; `trustWorkspace`.*

---

## v1 stories (next milestone)

### US-30 · Search a session — *v1*
As a Dev, I want to search a session's transcript so that I can find earlier context. **Screens:** S-22 · **Flow:** UF-14 · *`search-transcript`/`search-content`.*

### US-31 · Browse & read files — *v1*
As a Dev, I want to browse the workspace file tree and read files so that I can inspect code on the go. **Screens:** S-20, S-21 · *`list-files`/`read-file`; read-only (no Monaco).* 

### US-32 · Check CI / PR status — *v1*
As a Dev, I want to see PR checks and Actions runs so that I know if the build is green. **Screens:** S-25 · *`git-pr`/`git-actions-*`.*

### US-33 · Manage requirements — *v1*
As a Dev, I want to view and create requirement records so that I track what needs building. **Screens:** S-26 · *`requirement-*`.*

---

## future stories (M3 — full-parity surfaces)

> The deliberately-deferred surfaces (S-27…S-33) now get their spec/story/prototype cycle. Each maps a desktop panel to a **mobile-native** flow — no drag-and-drop, read-then-write, sandboxed preview, remote shell. Prototypes: `flow-UF-15.html` … `flow-UF-21.html`.

### US-34 · Read & add annotations — *future*
As a Dev, I want to read and add annotations pinned to a file and line so that I can capture review notes and TODOs against the code from my phone.
**Acceptance:** annotations list grouped by file, each row showing author (me / agent), `file:line`, note text, and age; ＋ adds a note at a picked `file:line` (or the current selection) and it appears optimistically; tapping a row opens the code frame + note with Edit / Resolve / Delete; resolved annotations collapse under a "Resolved" divider; destructive actions confirm.
**Screens:** S-27 · **Flow:** UF-15 · *Ports `AnnotationsPanel.tsx`; `annotation-list`/`-add`/`-resolve`.*

### US-35 · Preview an artifact — *future*
As a Dev, I want to preview artifacts the agent produced (HTML / SVG / Markdown) in a sandbox so that I can see rendered output without a desktop.
**Acceptance:** artifacts list with a type badge, size, and age; tapping one opens a **sandboxed** WebView preview (no network, no host/file access) with a shield note; a Preview ⇄ Source toggle; export / open-externally; unsupported types show source only; the sandbox origin is null.
**Screens:** S-28 · **Flow:** UF-16 · *Ports `ArtifactsPanel.tsx`; `artifact-list`/`-read`. Expo WebView with a locked-down `originWhitelist`.*

### US-36 · Manage schedules — *future*
As a Dev, I want to view and manage scheduled agent runs so that recurring work keeps happening without me.
**Acceptance:** schedules list (name, cadence in plain words e.g. "Every day · 09:00", next-run relative, last-run status, enabled toggle); ＋ creates one (name, prompt, cadence: Daily / Weekly / Cron); tapping a row opens detail with run history, **Run now**, Edit, Delete; toggling enabled persists host-side; a disabled schedule is visibly dimmed.
**Screens:** S-29 · **Flow:** UF-17 · *Ports `SchedulePanel.tsx`; `schedule-list`/`-add`/`-toggle`/`-run` (cron routines).*

### US-37 · Manage worktrees — *future*
As a Dev, I want to see and manage git worktrees so that I can juggle parallel branches from my phone.
**Acceptance:** worktrees list (branch, path, ahead/behind counts, clean/dirty dot, a "current" marker); ＋ creates a worktree (new branch + base); tapping a row opens actions (Switch / Open changes / Remove — remove confirms and refuses if dirty); switching re-scopes the active session to that worktree.
**Screens:** S-30 · **Flow:** UF-18 · *Ports `WorktreesPanel.tsx`; `worktree-list`/`-add`/`-remove`/`-switch`.*

### US-38 · Triage on a tap-to-move board — *future*
As a Dev, I want a tap-to-move task board so that I can triage sprint work without desktop drag-and-drop.
**Acceptance:** horizontally-scrollable columns (Backlog / Todo / In progress / Done) with per-column counts; cards show title, assignee, labels; tapping a card opens detail; **Move** opens a status sheet (tap a column — no DnD); a sprint switcher and a members filter; moves reflect optimistically and sync host-side.
**Screens:** S-31 · **Flow:** UF-19 · *Ports `TrackView.tsx`; `track-board`/`-move`/`-sprints` (no-DnD mobile redesign).*

### US-39 · Make a quick edit — *future*
As a Dev, I want a lightweight editor so that I can make a quick fix and save without a laptop.
**Acceptance:** opens from the read-only file viewer (S-21) via Edit; a syntax-highlighted editable buffer with line numbers; a keyboard accessory row (tab, brackets, save); an unsaved-changes dot + live +/− count; **Save** writes via the host and offers Review / Commit; large files warn; no full Monaco.
**Screens:** S-32 (from S-21) · **Flow:** UF-20 · *RN/WebView CodeMirror; `write-file` (Monaco replacement).*

### US-40 · Run a command on the host — *future*
As a Dev, I want a remote-shell view so that I can run a quick command on the host and read its output.
**Acceptance:** a mono scrollback of host-run output; a command input; running streams stdout/stderr and shows an exit code; long-running commands can be Stopped; a persistent "runs on the host · «workspace»" safety note; the shell executes **host-side** — nothing runs on-device — and the working directory is the active workspace.
**Screens:** S-33 · **Flow:** UF-21 · *Ports `TerminalPanel.tsx`; `term-run`/`term-stream` (remote shell; xterm replacement).*

---

## parity stories (new desktop capabilities)

> Surfaces newly implemented on the desktop app (post-M3) being ported to mobile. Prototypes: `flow-UF-22.html` …

### US-41 · Search my memory — *parity*
As a Dev, I want to search the brain memory engine from my phone so that I can recall codebase facts, decisions, and lessons on the go.
**Acceptance:** a search box queries `memory-search`; results list ranked recalls (type label, relevance score, content snippet) sorted highest-first; records whose source changed are flagged **stale**; tapping a recall shows the full content + provenance; read-only.
**Screens:** S-34 · **Flow:** UF-22 · *Ports `MemoryPanel.tsx`; `memory-search` (brain engine, #668).*

### US-42 · See my connectors — *parity*
As a Dev, I want to see my connected sources and their sync status from my phone so that I know my agent's context is fresh (and catch a broken connector).
**Acceptance:** a list of connectors sorted by health (active → error → paused), each showing source, name, flow count, last activity, and a status pill; error sources are highlighted; pull-to-refresh; a header count with the error tally; browse the catalog to add a source.
**Screens:** S-35 · **Flow:** UF-23 · *Ports the desktop connector catalog; `connectors-list`/`connectors-catalog`.*

---

## Coverage map (story → milestone → prototype)

| Milestone | Stories | Prototyped |
|---|---|---|
| **MVP** | US-01…US-29 | yes (`flow-US-01.html` … `flow-US-29.html`) |
| **v1** | US-30…US-33 | yes (documented; prototypes included) |
| **future** | US-34…US-40 (S-27…S-33) | yes (`flow-UF-15.html` … `flow-UF-21.html`) |
| **parity** | US-41…US-42 (S-34, S-35) | yes (`flow-UF-22.html`, `flow-UF-23.html`) |

> The M3 "full-parity" surfaces (Annotations, Artifacts, Schedules, Worktrees, Track board, in-app Editor, Terminal) now have stories + flows + prototypes — this was their scheduled spec/story/prototype cycle. Each is a **mobile-native redesign** of its desktop panel (no drag-and-drop, read-then-write, sandboxed preview, remote shell), not a 1:1 port. Implementation is still sequenced last per [roadmap.md](roadmap.md); several may be re-scoped based on MVP/v1 usage.

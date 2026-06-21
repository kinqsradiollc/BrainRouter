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

## Coverage map (story → milestone → prototype)

| Milestone | Stories | Prototyped |
|---|---|---|
| **MVP** | US-01…US-29 | yes (`flow-US-01.html` … `flow-US-29.html`) |
| **v1** | US-30…US-33 | yes (documented; prototypes included) |
| **future** | (S-27…S-33 screens) | deferred — documented in [roadmap.md](roadmap.md), not yet prototyped |

> Future-milestone surfaces (Annotations, Artifacts, Schedules, Worktrees, Track board, in-app Editor, Terminal) are intentionally **not** given stories/prototypes yet — they're sequenced in the roadmap and will get their own spec/story/prototype cycle when scheduled. This is a deliberate scope boundary, not an omission.

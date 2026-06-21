# UI Specification — BrainRouter Mobile

> Mobile (React Native / Expo) UI spec for the BrainRouter port. Grounded in [investigation-summary.md](investigation-summary.md).
> Scope follows the **MVP-first, parity-over-time** decision. Every screen maps to **real desktop functionality** — nothing here is invented; recommendations/assumptions are labelled **[ASSUMPTION]** / **[REC]**.
> Screen IDs (`S-xx`) are referenced by [user-flows.md](user-flows.md), [user-stories.md](user-stories.md), and the HTML prototypes.

---

## 1. Design philosophy for mobile

The desktop is a **dense, multi-pane, keyboard-and-hover IDE**. The phone inverts every one of those assumptions, so the mobile app is reframed as a **"remote control for your coding agent"**: you carry the *monitor + approve + review* loop in your pocket while the heavy editing/terminal work stays on the desktop/host.

Three rules drive every screen:
1. **One primary surface at a time.** The desktop's simultaneous Sidebar + Chat + Env + Panels + Terminal becomes a tab bar + stack navigation + bottom sheets.
2. **Everything tappable, nothing hover-only.** Desktop hover actions and `title=` tooltips (which carry exact values) become always-visible chips, long-press menus, and tap-to-expand rows.
3. **Approvals and status are first-class.** The agent runs remotely and asynchronously; the app must surface "the agent needs you" (tool approvals, review gates, interaction questions) via push-style affordances, not a buried inline card.

---

## 2. Design system (tokens)

Tokens are lifted directly from `brainrouter-desktop/src/theme.css` and expressed as a React Native theme object. Dark is the default; a high-contrast (`hc`) variant and a user-overridable `accent` are supported, matching desktop runtime theming.

### 2.1 Color tokens

```ts
export const colors = {
  // surfaces
  bg:           'hsl(240 6% 5%)',    // app background (near-black)
  surface:      'hsl(240 5% 9%)',    // cards / panels
  sidebar:      'hsl(240 7% 4%)',    // nav surfaces / tab bar
  raised:       'hsl(240 5% 13%)',   // chips / raised cards
  input:        'hsl(240 6% 8%)',    // text inputs
  termBg:       'hsl(240 8% 3%)',    // code/console blocks
  userBubble:   'hsl(240 5% 11%)',   // user message bubble
  // borders
  border:       'hsl(240 5% 15%)',
  borderStrong: 'hsl(240 5% 21%)',
  // text
  text:         'hsl(0 0% 96%)',
  textDim:      'hsl(240 5% 72%)',
  textFaint:    'hsl(240 4% 50%)',
  // accent (user-overridable at runtime) + brand
  accent:       'hsl(245 80% 66%)',  // indigo — primary actions, active states
  accentSoft:   'hsla(245 80% 66% / .14)',
  brand:        'hsl(16 65% 58%)',   // warm orange — BrainRouter mark / highlights
  // status
  ok:           'hsl(142 60% 45%)',
  warn:         'hsl(38 85% 48%)',
  err:          'hsl(0 72% 55%)',    // [REC] true red on mobile for clearer error semantics
  // white-overlay interaction scale (hover→pressed tints)
  ov: { o025:'rgba(255,255,255,.025)', o05:'rgba(255,255,255,.05)', o08:'rgba(255,255,255,.08)',
        o12:'rgba(255,255,255,.12)', o18:'rgba(255,255,255,.18)', o26:'rgba(255,255,255,.26)' },
}
```

### 2.2 Spacing, radius, type, motion

```ts
export const space  = { xs:4, sm:8, md:12, lg:16, xl:24, xxl:32 }      // 4-pt scale
export const radius = { sm:9, md:14, lg:20, pill:999 }                  // from --r-sm/md/lg
export const type = {
  font: 'System',                                        // maps to --font (apple-system/Inter/Segoe)
  mono: Platform.select({ ios:'Menlo', android:'monospace' }),
  // mobile type scale (bumped from desktop's 12.5px base for readability)
  display:22, title:17, body:15, bodySm:13.5, caption:12, micro:11,
  lineHeight: { body:21, bodySm:19 },
}
export const touch = { min:44 }   // [REC] iOS HIG / Material min touch target — replaces desktop's dense rows
export const motion = { fast:120, base:200, sheet:280 }  // ms; sheet matches a natural spring
```

### 2.3 Elevation & safe areas
- No drop shadows in the dark theme (matches desktop's flat graphite look); separation is by `surface`/`border` contrast and the `ov` overlay scale.
- All full-screen surfaces respect `SafeAreaView` insets (notch, home indicator). The tab bar sits above the bottom inset; the composer floats above the keyboard via `KeyboardAvoidingView`.

---

## 3. Core primitives (shared components)

These reimplement the desktop primitives (`Button`, `Badge`/`Chip` via `lib/ui/controlClass.ts`, `UsageBar`, `ContextRing`, `icons.tsx`) as RN components. Each has explicit states.

| Primitive | Purpose | Notes / desktop source |
|---|---|---|
| `Button` | primary / secondary / ghost / danger; sizes sm/md | variant system ported from `controlClass.ts`; min height 44 |
| `Chip` / `Badge` | status & metadata pills (running, pinned, severity, role) | from `Badge.tsx`; always visible (no hover) |
| `Card` | grouped content container (surface + border + radius.md) | base for ChatRow, ToolCard, ListRow |
| `ListRow` | tappable row w/ leading icon, title, subtitle, trailing meta/chevron | replaces desktop dense list rows; long-press → action sheet |
| `Sheet` | bottom sheet (snap points) for pickers, detail, menus | replaces desktop popovers / right-click menus / ctx-menu |
| `Modal` | full-screen or centered modal (approvals, trust, info) | replaces desktop dialogs |
| `Icon` | line-SVG set via `react-native-svg` | ported 1:1 from `icons.tsx` |
| `ProgressBar` | labelled bar (token usage, context fill) | from `UsageBar.tsx` |
| `ContextRing` | small SVG arc for context-window fill | from `ContextRing.tsx` → `react-native-svg` |
| `CodeBlock` | mono, syntax-highlighted, horizontal-scroll, copy button | `react-native-syntax-highlighter` (replaces Prism) |
| `DiffView` | unified-diff render (added/removed lines) | logic from `panels/diff.tsx` + `reviewCode.ts` (both pure/portable) |
| `Markdown` | chat markdown + GFM | `react-native-markdown-display` (replaces react-markdown) |
| `EmptyState` / `ErrorState` / `Skeleton` | standard empty / error / loading scaffolds | every data screen uses these |
| `StatusDot` | running / ok / fail / interrupted indicator | from `SessionStatus.tsx` |
| `Avatar` | project / account glyph | new, minimal |

**Universal states convention** (applies to every data-bearing screen/component): **loading** → `Skeleton`; **empty** → `EmptyState` (icon + line + optional CTA); **error** → `ErrorState` (message + Retry); **populated** → content. Connection loss shows a global "Reconnecting…" banner (see S-15 / §6).

---

## 4. Navigation model

```
RootNavigator (stack)
├── ConnectStack            (pre-auth — shown until paired with a host)
│   └── S-01 Connect / Pair host
└── AppTabs (bottom tabs)   (post-pairing)
    ├── Tab: Chats   → ChatsStack
    │   ├── S-02 Chats (projects + sessions)
    │   ├── S-03 Session (chat)         ← the core screen
    │   ├── S-07 Changes / Diff
    │   ├── S-08 Tool / message detail
    │   ├── S-09 Background-task / Workflow transcript
    │   ├── S-20 Files browser (v1)
    │   ├── S-21 File viewer (v1)
    │   └── S-22 Search session
    ├── Tab: Activity → S-10 Dashboard (cross-workspace tasks)
    ├── Tab: Review  → ReviewStack
    │   ├── S-11 Review inbox (findings + gates)
    │   └── S-12 Finding detail
    └── Tab: Settings → SettingsStack
        ├── S-14 Settings home
        ├── S-15 Connection (host/token)
        ├── S-16 Models & providers
        └── S-17 Appearance

Modal/sheet layer (over anything):
  S-04 Composer pickers (Mode / Model / Effort / Branch)
  S-05 Approval (tool confirm / choice)   ← interaction-request
  S-06 Plan (review & approve)
  S-13 Review-gate block
  S-18 Project picker / Add project
  S-19 Workspace trust prompt
  S-23 Context-usage detail
  S-24 Session ⋮ actions (pin/rename/fork/archive/delete)
```

**Workspace context** is global (a header switcher, S-18), not per-screen: Activity/Review/Chats all read the currently-selected workspace, mirroring how the desktop scopes panels to the active workspace.

---

## 5. Screen inventory

Status: **MVP** (first release), **v1** (next), **future**. "Desktop source" anchors each screen to real functionality.

| ID | Screen | Tab | Status | Desktop source |
|---|---|---|---|---|
| S-01 | Connect / Pair host | — | **MVP** | *new* (replaces local `utilityProcess`); pairs to remote host |
| S-02 | Chats (projects + sessions) | Chats | **MVP** | `Sidebar.tsx`, `projectSessionsView.ts`, `list-sessions` |
| S-03 | Session (chat) | Chats | **MVP** | `ChatThread.tsx` + `Composer.tsx` + `useAgentEvents` |
| S-04 | Composer pickers (sheets) | Chats | **MVP** | `Composer.tsx` mode/model/effort/branch popovers |
| S-05 | Approval (confirm/choice) | modal | **MVP** | inline approval card + `InteractionDialogs.tsx` |
| S-06 | Plan (review & approve) | sheet | **MVP** | `PlanPanel.tsx`, `plan-state`/`plan-history` |
| S-07 | Changes / Diff | Chats | **MVP** | `DiffPanel.tsx`, `EnvironmentPanel.tsx`, `changed-files`/`file-diff` |
| S-08 | Tool / message detail | Chats | **MVP** | `ToolGroup.tsx`, `MessageRow.tsx`, `ToolsPanel.tsx` |
| S-09 | Background-task / Workflow transcript | Chats | **MVP** | `TasksPanel.tsx`, `WorkflowCard.tsx`, `task-transcript`/`workflow-detail` |
| S-10 | Activity (Dashboard) | Activity | **MVP** | `DashboardPanel.tsx`, `globalDashboard`, `fleet` |
| S-11 | Review inbox | Review | **MVP** | `ReviewPanel.tsx`, `review-current`/`review-status`/`review-gate` |
| S-12 | Finding detail | Review | **MVP** | `ReviewPanel.tsx` per-finding actions |
| S-13 | Review-gate block | sheet | **MVP** | `InfoAndGateDialogs.tsx` review-gate dialog |
| S-14 | Settings home | Settings | **MVP** | `settings.tsx` category nav |
| S-15 | Connection (host/token) | Settings | **MVP** | *new* (transport security) |
| S-16 | Models & providers | Settings | **MVP** | `settings.tsx` Models, `list-models`, `action:set-llm/-provider` |
| S-17 | Appearance | Settings | **MVP** | `theme`/`accent`/font prefs (`App.tsx:581-606`) |
| S-18 | Project picker / Add | sheet | **MVP** | `workspaceRecents`/`openWorkspace`/`addWorkspace` |
| S-19 | Workspace trust prompt | modal | **MVP** | `InteractionDialogs.tsx` trust prompt, `isWorkspaceTrusted` |
| S-23 | Context-usage detail | sheet | **MVP** | `ContextPanel.tsx`, `context-usage`/`usage-breakdown` |
| S-24 | Session ⋮ actions | sheet | **MVP** | `ExportAndMenuDialogs.tsx` per-chat menu |
| S-22 | Search session | Chats | **v1** | `SearchPanel.tsx`, `search-transcript`/`search-content` |
| S-20 | Files browser (read-only) | Chats | **v1** | `FilesPanel.tsx`, `list-files` |
| S-21 | File viewer (read-only) | Chats | **v1** | `FileViewerPanel.tsx`, `read-file` |
| S-25 | CI / Checks | Chats | **v1** | `CIPanel.tsx`, `git-pr`/`git-actions-*` |
| S-26 | Requirements | Chats | **v1** | `RequirementsPanel.tsx` |
| S-27 | Annotations | Chats | **future** | `AnnotationsPanel.tsx` |
| S-28 | Artifacts (preview) | Chats | **future** | `ArtifactsPanel.tsx` |
| S-29 | Schedules | Chats | **future** | `SchedulePanel.tsx` |
| S-30 | Worktrees | Chats | **future** | `WorktreesPanel.tsx` |
| S-31 | Track board | (own) | **future** | `TrackView.tsx` |
| S-32 | Code editor | Chats | **future** | `EditorPanel.tsx` (Monaco replacement) |
| S-33 | Terminal | Chats | **future** | `TerminalPanel.tsx` (xterm replacement) |

---

## 6. MVP screen specs

### S-01 · Connect / Pair host
**Purpose:** first-run pairing to a remote `brainrouter-core` host (the net-new backend). Replaces the desktop's in-process `utilityProcess`.
**Components:** BrainRouter wordmark; host URL input (`wss://host:port`); auth-token input (or **"Scan QR"** to pair — **[REC]** host prints a QR with URL+token); "Connect" primary button; "How to start a host?" help link; recent hosts list.
**Layout:** centered single-column, generous vertical rhythm, keyboard-avoiding.
**States:** *empty* (no hosts yet, help text prominent) · *loading* (Connecting… spinner on button) · *error* (unreachable / bad token / TLS — inline message + Retry) · *success* (→ AppTabs, lands on S-02).
**Interactions:** validate URL scheme; persist host+token to SecureStore; auto-reconnect on app resume.
**[ASSUMPTION]** the host exposes a token-authenticated WS/SSE endpoint (defined in [technical-doc.md](technical-doc.md)).

### S-02 · Chats (projects + sessions) — Chats tab landing
**Purpose:** browse projects (workspaces) and their chat sessions; entry to everything. Mirrors `Sidebar.tsx` + `projectSessionsView.ts`.
**Components:**
- Header: workspace/project switcher (tap → S-18), "＋ New chat" action, overflow (sort/filter).
- Sectioned list: **projects** (collapsible) → **sessions** under each. Session `ListRow`: status dot (`SessionStatus`), title (first user message / label), relative age (`fmtAge`), turn count, pinned ★ / forked ⑂ markers, running spinner if a turn is live.
- "Show N more" / "Archived" expanders per project (`sessionPagination`).
- Pull-to-refresh (**[REC]** replaces desktop auto-refresh).
**Layout:** single scroll list; sticky section headers; FAB-free (New chat lives in header).
**States:** *loading* skeleton rows · *empty* ("No projects yet — Add a project" CTA → S-18) · *error* Retry · *populated*.
**Interactions:** tap session → S-03; long-press session → S-24 (pin/rename/fork/complete/archive/delete); tap project header → expand/collapse (persisted, `expandedProjectsStore` → AsyncStorage); tap switcher → S-18.

### S-03 · Session (chat) — the core screen
**Purpose:** the agent conversation: read the transcript, watch live work, send turns, approve actions. Ports `ChatThread.tsx` + `Composer.tsx`, driven by the ported `useAgentEvents` router over the remote transport.
**Components:**
- **Top bar:** back; session title (tap → rename); `StatusDot`; `ContextRing` (tap → S-23); overflow ⋮ (→ S-24, Export, Search, Changes, Plan).
- **Transcript (FlatList, inverted):** renders `ChatRow` union as cards —
  - *user* bubble (right-ish, `userBubble`); *assistant* markdown bubble with streaming caret;
  - *reasoning* collapsible "Thinking" block (`thinkParse`);
  - *tool-group* → `ToolCard`(s): tool verb+icon (`toolVisual`), summary, ok/fail dot, tap → S-08; file-scoped tools show basename + tap-to-diff;
  - *plan-update* → inline `PlanCard` (tap → S-06);
  - *changeset* → `ChangeSummary` bar (files +/− , tap → S-07);
  - *briefing* → recalled-memory chips; *status*/*error*/*cmd-out*/*loading* rows.
  - **Working indicator:** spinner + elapsed (`WorkElapsed`) + live reasoning tail.
- **Inline approval card** (when `interaction-request` arrives & sheet dismissed) + a sticky **"Agent needs you"** banner that opens S-05.
- **Goal banner** (`GoalBanner`) sticky at top when a `/goal` is active (edit/pause/resume).
- **"↓ Latest"** floating button when scrolled up.
- **Composer (bottom, keyboard-avoiding):** auto-grow text input; attach (＋ → image/doc via Expo picker); send/stop; **pill row** above input → Mode · Model · Effort · Branch (tap → S-04 sheets); slash-command `/` opens an in-composer command picker (ported `commands.ts` + `resolveSlashInput` so a slash is never sent to the LLM); `@`/attachment chips.
**Layout:** transcript fills; composer pinned; banners overlay top.
**States:** *loading* (resuming session → skeleton transcript) · *empty* = **Home** (greeting, stats, heatmap, "pick up where you left off" recents — from `HomeView.tsx`) when no messages · *streaming* (caret + working line) · *awaiting-approval* (banner) · *error* (turn-error card + Retry) · *interrupted* (stopped state).
**Interactions:** send turn (`start-turn`); stop (`interrupt`); approve/deny from card or S-05; tap tool/plan/changeset → detail; long-press a message → copy/fork (always-visible on mobile, replacing hover strip).

### S-04 · Composer pickers (bottom sheets)
**Purpose:** the four desktop composer popovers as native sheets. Ports `Composer.tsx` menus.
- **Mode sheet:** Plan / Accept-edits / Auto (with effect descriptions) — `set-session-mode`.
- **Model sheet:** grouped models + capability badges (`modelCapabilities`), search, "All chats / This chat only" scope, Fast-mode toggle — `list-models` / `set-model`.
- **Effort sheet:** Faster → Smarter slider/segmented.
- **Branch sheet:** git branch list, tap to checkout — `git-branches` (read MVP; checkout v1).
**States:** loading (model list) · error (provider fetch failed) · populated. **Interactions:** select → apply + close; selection reflected in the composer pill.

### S-05 · Approval (tool confirm / choice) — modal
**Purpose:** the agent's `interaction-request` (tool-approval `confirm`, or multiple-`choice` question). The single most important mobile-native moment. Ports the inline approval card + `InteractionDialogs.tsx`, with the fail-closed 5-min timeout honored.
**Components:** title (tool name / question); details (command/diff preview, `CodeBlock`/`DiffView`); for confirm → **Allow once / Always allow / Deny**; for choice → single/multi-select list + Submit; countdown hint if near timeout.
**Layout:** bottom-anchored modal sheet, content scrolls, actions pinned. **States:** populated · submitting · expired (auto-dismissed → "request timed out"). **Interactions:** reply via `interaction-response`; **[REC]** deliver as a push notification when app is backgrounded (see [ux-enhancements.md](ux-enhancements.md)).

### S-06 · Plan (review & approve) — sheet/screen
**Purpose:** the agent's live plan + plan-review + version history. Ports `PlanPanel.tsx`.
**Components:** plan items checklist (pending/in-progress/completed, with acceptance text); per-step note (tap → input modal, replacing `window.prompt`); approval banner → **Approve / Request changes** (+ feedback input, launches a revision task); collapsible version history with per-decision diff.
**States:** loading · empty ("no plan yet") · awaiting-approval (banner highlighted) · populated. **Interactions:** `plan-record-decision`; approve/request-changes.

### S-07 · Changes / Diff
**Purpose:** working-tree changes + per-file diff; commit/push (gated). Ports `DiffPanel.tsx` + `EnvironmentPanel.tsx` git section.
**Components:** changed-files list (path, +/− counts, status badge, findings count); tap → per-file `DiffView` (read); branch indicator; **Commit** (message input) / **Push** / **Pull** buttons with the **review-gate** guard (blocked → S-13). **[REC]** MVP = read diffs + commit/push; deep edit stays desktop.
**States:** loading · empty ("working tree clean") · error · populated (+ gate-blocked banner). **Interactions:** `changed-files`/`file-diff`; `runGit` commit/push (gated); tap finding count → S-12.

### S-08 · Tool / message detail
**Purpose:** full detail of a tool call or message. Ports `ToolGroup.tsx`/`ToolsPanel.tsx`/`MessageRow.tsx`.
**Components:** tool name, args, full output (`CodeBlock`, scrollable), ok/fail, duration; file link → S-07/S-21; copy. **States:** populated · error. **Interactions:** copy, open file/diff, fork-from-here.

### S-09 · Background-task / Workflow transcript
**Purpose:** read-only transcript of a sub-agent/background task, or a workflow's phase/agent/token breakdown. Ports `TasksPanel.tsx` row → transcript and `WorkflowCard.tsx`.
**Components:** task header (kind/label/status/phase/elapsed); read-only transcript (same ChatRow renderers); for workflows: phase list + per-agent token table (stacked for mobile). **States:** loading · running (live) · finished · error. **Interactions:** `task-transcript`/`workflow-detail`; back to chat.

### S-10 · Activity (Dashboard) — Activity tab
**Purpose:** cross-workspace running/finished/failed tasks, workflows, agents — the "what's happening" hub. Ports `DashboardPanel.tsx` + `globalDashboard`.
**Components:** scope toggle (This workspace / All); segmented tabs (Running · Finished · Failed · Workflows · Agents · Bash) with counts; per-workspace groups; task rows (kind/label/status/phase/elapsed) with **Stop** action (always-visible button, not hover); review-gate badge per workspace (tap → Review). **States:** loading · empty ("nothing running") · error · populated. **Interactions:** pull-to-refresh; tap row → S-09; Stop → `interrupt`; tap gate badge → S-11.

### S-11 · Review inbox — Review tab
**Purpose:** the "needs you" inbox — review findings for the active workspace + review-gate status. Ports `ReviewPanel.tsx` + `review-current`/`review-status`/`review-gate`.
**Components:** Run/Re-run review button + status (needs/reviewing/blocked/passed/stale via `reviewBadgeFor`); findings grouped by file; finding row: severity + confidence + title + line ref. **States:** loading · empty ("no findings — clean") · reviewing (progress) · error · populated. **Interactions:** run review (`review-rerun`); tap finding → S-12.

### S-12 · Finding detail
**Purpose:** one review finding + its actions. Ports `ReviewPanel.tsx` per-finding cluster (condensed for mobile).
**Components:** severity/confidence; line-numbered code frame (`CodeBlock`); collapsible patch (`DiffView`); **action row** condensed into primary buttons + an overflow sheet: Apply suggestion / Ask agent to fix / Discuss in chat / Annotate / Open diff / Open file / Resolve / Dismiss / Acknowledge / Dispute / Out-of-scope. **States:** populated · applying · error. **Interactions:** `review-apply-suggestion`/`review-fix-finding`/`review-set-finding-status`/`review-dismiss`/`review-resolve`.

### S-13 · Review-gate block — sheet
**Purpose:** when commit/push is refused until review is clean. Ports `InfoAndGateDialogs.tsx`.
**Components:** explanation; **Run review / Open review / Commit without review (bypass) / Cancel**. **Interactions:** route to S-11 or bypass (`runGit` with bypass flag).

### S-14 · Settings home — Settings tab
**Purpose:** settings hub as a drilldown list (desktop's two-pane 980×660 modal → mobile list). Ports `settings.tsx` categories.
**Components:** grouped `ListRow`s → Connection (S-15), Models & providers (S-16), Appearance (S-17), Permissions, Memory, Hooks, Workflow automation, Extensions, Connectors, Integrations, Advanced, Usage. MVP wires Connection/Models/Appearance/Usage; others are v1 stubs reachable but labelled. **States:** populated. **Interactions:** tap → category screen.

### S-15 · Connection (host/token)
**Purpose:** manage the remote host connection (the mobile-only transport layer). **Components:** current host + status (Connected/Reconnecting/Offline); edit URL/token; "Test connection"; "Forget host"; reconnect policy. **States:** connected · reconnecting (banner) · offline (Retry). **Interactions:** persist to SecureStore; live status from the transport.

### S-16 · Models & providers
**Purpose:** choose chat model + manage providers. Ports `settings.tsx` Models + `list-models`/`action:set-llm`/`action:set-provider`. **Components:** active model + capability badges; provider list (add/remove/set-default — keys entered on device sent to host over the secure channel, **[ASSUMPTION]** keys live host-side per investigation §8); model picker (shared with S-04). **States:** loading · error (provider fetch) · populated.

### S-17 · Appearance
**Purpose:** theme + accent + code font. Ports `App.tsx:581-606` prefs. **Components:** Theme (Dark / High-contrast); Accent color picker; Code font; Chat text size (`--chat-fs`). **Interactions:** persist locally; apply via ThemeProvider.

### S-18 · Project picker / Add — sheet
**Purpose:** switch active workspace or add one. Ports `workspaceRecents`/`openWorkspace`/`addWorkspace`. **Components:** recents list (ordered, `markActivity`); search; **Add**: pick from the **host's** known roots (not the device filesystem — folder picking is host-side). **States:** loading · empty · populated. **Interactions:** select → `openWorkspace` (may trigger S-19 trust); reorder (long-press drag, `reorderWorkspace`).

### S-19 · Workspace trust prompt — modal
**Purpose:** "Do you trust this folder?" gate before opening. Ports `InteractionDialogs.tsx` trust + `isWorkspaceTrusted`/`trustWorkspace`. **Components:** path, explanation, **Trust / Cancel**. **Interactions:** `trustWorkspace`; remembered host-side.

### S-23 · Context-usage detail — sheet
**Purpose:** token/context breakdown. Ports `ContextPanel.tsx` + `context-usage`/`usage-breakdown`. **Components:** context-window fill bar with auto-compact marker; token hero; savings; per-bucket breakdown; model/branch/session env rows + copy-session-id. **States:** loading · populated.

### S-24 · Session ⋮ actions — sheet
**Purpose:** per-session actions. Ports `ExportAndMenuDialogs.tsx` menu. **Components:** Pin/Unpin, Complete, Rename, Fork, Move to group, Export (Markdown/JSON), Archive, Delete (confirm). **Interactions:** `action:session-meta`/`-fork`/`-delete`, `export-chat`.

---

## 7. v1 / future screens (lighter specs)

- **S-22 Search session (v1):** search box → ranked transcript hits (`search-transcript`/`search-content`); tap → jump to message. Already mobile-friendly on desktop.
- **S-20 Files browser (v1, read-only):** collapsible folder tree (`list-files`), `?` content grep; tap file → S-21. Drops desktop multi-pane; pure navigation.
- **S-21 File viewer (v1, read-only):** syntax-highlighted read (`read-file` + `react-native-syntax-highlighter`); copy; open-diff. **No Monaco** (deferred to S-32 future).
- **S-25 CI/Checks (v1):** PR header + check rollup + recent Actions runs (`git-pr`/`git-actions-*`); open-on-GitHub; rerun-failed.
- **S-26 Requirements (v1):** requirement records list + detail (status/priority/criteria/Q&A); create/seed-plan.
- **S-27 Annotations / S-28 Artifacts / S-29 Schedules / S-30 Worktrees (future):** authoring/management surfaces; artifacts get a sandboxed HTML/SVG preview via WebView.
- **S-31 Track board (future):** kanban → tap-to-move status sheets (no DnD); list/sprints/members.
- **S-32 Code editor (future):** lightweight RN/WebView editor as a Monaco replacement.
- **S-33 Terminal (future):** remote-shell stream view (host runs the shell; RN renders output) — or omit permanently.

---

## 8. Component → desktop mapping (appendix)

| Mobile component | Desktop origin | Portability |
|---|---|---|
| ChatRow renderers | `chat/MessageRow.tsx`, `ToolGroup.tsx`, `markdown.tsx` | logic portable; re-skin to RN |
| ToolCard | `ToolGroup.tsx` + `toolVisual.ts` | `toolVisual` pure → reuse |
| PlanCard / Plan screen | `PlanPanel.tsx` + `planReviewView.ts` | view-model pure → reuse |
| DiffView | `panels/diff.tsx` + `reviewCode.ts` | pure parsers → reuse |
| Composer + pickers | `Composer.tsx` + `commands.ts` + `slashHighlight.ts` | command logic pure → reuse |
| Sessions list | `Sidebar.tsx` + `projectSessionsView.ts` + `useSessionSidebar.ts` | derived logic pure → reuse |
| Dashboard | `DashboardPanel.tsx` + `workspace/dashboard.ts` | `dashboard.ts` pure → reuse |
| Review | `ReviewPanel.tsx` + `reviewWorkspace.ts`/`reviewGateUi.ts` | view-models pure → reuse |
| ContextRing / ProgressBar | `ContextRing.tsx` / `UsageBar.tsx` | SVG → `react-native-svg` |
| Theme | `theme.css` | tokens → RN object |
| Icons | `icons.tsx` | SVG → `react-native-svg` |

Everything marked "pure → reuse" moves into `brainrouter-mobile/src/domain/` largely unchanged (see [technical-doc.md](technical-doc.md) §folder-structure).

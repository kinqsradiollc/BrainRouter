# ADR-057 — Session-workflow ergonomics: agent task suggestions and a split chat view

**Status:** ACCEPTED — implemented on `release/0.4.22` as two small PRs. A1 (agent task suggestions) ships with this ADR; A2 (split chat view) follows.

## Context

Working *inside* BrainRouter should feel like working with the coding agent that builds it. Two ergonomics from that agent are missing from the desktop:

1. **The agent can only do the task in front of it.** When it notices an out-of-scope fix or improvement mid-turn — dead code, a stale doc, a missing test, a security nit — it either derails the current change to chase it or drops it on the floor. The coding agent instead flags it as a one-click follow-up the human can spin off later. BrainRouter already has the *receiving* half of this: `triggers/suggestedTasks.ts` scans a connected repo for startable work, and the Tasks panel renders those as "Suggested starters" with a `Start ▾` menu (here / new session / new worktree). What is missing is a way for the **agent itself** to author a suggestion.

2. **You can only look at one chat at a time.** Comparing two runs — a fix and its review, an experiment against a baseline, two agents on sibling tasks — means switching back and forth. The coding agent shows two sessions side by side. The desktop host already runs multiple sessions concurrently (a per-`sessionKey` runtime pool, events tagged by session); only the renderer is built around one active session.

## Decisions

### D1 · `suggest_task` — the agent flags a follow-up, the human starts it

A first-party builtin tool `suggest_task` (planning-state capability, read tier, no approval) records an out-of-scope follow-up in a **workspace-scoped store** (`agent-suggestions.json` via `getStateFile`, `triggers/suggestionStore.ts`). A record is `{ id, title, suggestedPrompt, reason?, worktree?, createdBySessionKey?, createdAt, status }`; the store dedupes a repeat of the same pending title, caps at 50, and never evicts a pending item.

The desktop surfaces the open ones in the Tasks panel as a **"Suggestions from the agent"** section, above the repo-scanner starters, reusing the existing `Start ▾` launcher (`onStartSuggested`): **Start here** (draft into the current composer), **New session** (a fresh chat), **New worktree** (an isolated branch), or worktree-from-branch — plus a **Dismiss**. Starting or dismissing flips the record's status through the `agent-suggestion-status` host query, so a suggestion leaves the tray once acted on.

The tool never changes the current work; it is the agent's way of saying "worth doing, not now, not here."

*Acceptance:* the agent calling `suggest_task` records a pending suggestion; it appears in the Tasks panel; `Start ▾ → New worktree` launches it seeded with the prompt on an isolated worktree; Dismiss removes it. A repeated pending title does not pile up. The store stays bounded.

### D2 · Split chat view — two sessions side by side

A renderer layout that mounts two chat panes in the work row, each bound to its own `sessionKey`, so two sessions are visible at once. The host already streams both (its runtime pool is per-session and multi-live); the change is renderer-side: per-pane session-scoped state, an event router that dispatches each host event to the pane owning `msg.sessionKey` rather than dropping everything non-foreground, and a `start-turn`/`interrupt` that can target a pane's session. The composer in each pane submits to that pane's session; a split toggle opens/closes the second pane and picks its session.

*Acceptance:* with the split on, two sessions render side by side; typing in either pane runs a turn in *that* session and streams into *that* pane; both can be mid-turn at once; closing the split returns to the single view with the focused session intact.

## What this is not

- Not a second copy of the workspace — both panes share one workspace and its host session pool. The split is about *viewing*, not isolating (worktrees do isolation).
- `suggest_task` is not the Track board. A suggestion is a lightweight, agent-authored, dismissable follow-up (closer to a reminder than an epic); promoting one to formal project work is a separate, deliberate act.

## Board

- **A1 — agent task suggestions** (D1) — `suggest_task` tool + `suggestionStore` + Tasks-panel section + host queries. **✅ ships with this ADR.**
- **A2 — split chat view** (D2) — per-pane renderer state, event routing by `sessionKey`, targeted `start-turn`, layout + toggle. **In progress.**

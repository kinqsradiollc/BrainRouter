# Spec — The unified workspace: Chat · Track · Code

> Status: **in progress** on `feat/unified-workspace`. One app, three modes over
> the same workspace + the same BrainRouter memory. This spec is the contract;
> implementation lands in foundation-first slices (data model → store → agent
> tools → CLI → desktop UI + mode switcher).

## Goal

Keep planning, coordination, and implementation in one place. A mode switcher at
the top of the window flips the surface; the **project, the memory, and the agent
are shared** across all three modes.

- **Chat** — a lightweight conversational/assistant surface (ask, explore, design,
  draft) without the full coding-agent loop. Can promote a thread into a Code turn
  or a Track work item.
- **Track** — a first-party, code-aware, **Jira-class** project-management surface.
  **Each workspace is a project** with its own configuration and management.
- **Code** — today's agentic coding mode (desktop + TUI), unchanged.

## Why first-party (not an integration)

Track is code-aware: the agent reads and writes the tracker as a first-class tool,
work items link to branches/commits/PRs/reviews/artifacts, and every record
captures into BrainRouter memory with full provenance — none of which a bolted-on
external integration gives us. Everything stays in one store, one provenance graph.

## Domain model (Track P1 — `packages/types/src/track.ts`)

One **project per workspace** (`TrackProject`, keyed by `workspaceRoot`), holding
its key prefix, configurable workflow states, issue types, and components.

- **WorkItem** — the unit of work: `issue · story · bug · task · sub-task · epic`
  (+ custom types). Human key (`PROJ-123`), title/description, status (a
  project-defined `WorkflowState`, bucketed into a `StatusCategory` for boards +
  reports), priority (`lowest…highest`), assignee/reporter/watchers, labels,
  components, estimate/story-points, due date, parent (sub-tasks), epic link,
  sprint link, **dependency links** (`blocks · blocked-by · relates-to ·
  duplicates`), comments, attachments, and an append-only **activity log**.
- **Sprint** — `future · active · completed`, goal, start/end, capacity; work items
  reference it by `sprintId`.
- **Board** — `kanban · scrum`, ordered columns (each mapping to one or more
  workflow states), optional swimlanes + WIP limits, and a saved filter/query.
- **Provenance (the differentiator)** — every WorkItem carries `workspaceRoot`,
  optional `sessionKey`, `linkedMemoryIds`, and **code links** (`branch · commit ·
  pullRequest · file`), plus links to the existing `requirementId` / `taskIds` /
  `artifactIds` / review-finding ids, so the requirement → plan → task → review →
  verify flow maps onto Track items.

All contracts follow the package house style: dependency-free, plain-`string` id
aliases, camelCase keys, ISO-8601 timestamps, union enums with `is*` type guards.

## Build order

1. **P1 — data model** (this slice): the contracts above + type guards + tests.
2. **P2 — durable store** (`packages/core`): file-backed per-workspace CRUD, key
   allocation, query/filter, activity log, memory capture with provenance.
3. **P3 — agent tools**: list/create/update/transition/query/link so the agent
   manages the board itself; wire the requirement→…→verify mapping.
4. **P4 — surfaces**: `/track` CLI commands; desktop Track panel (board · list ·
   backlog · sprint · roadmap views) + the Chat·Track·Code mode switcher + Chat.
5. **Later**: JQL-style query language, reports (velocity, cumulative flow,
   cycle/lead time), automation rules, per-project permissions.

## Non-goals (for now)

External Jira/GitHub-Issues sync (a later provider), real-time multi-user
collaboration, and a hosted backend — Track is local-first over the existing
per-workspace store, same as requirements/annotations.

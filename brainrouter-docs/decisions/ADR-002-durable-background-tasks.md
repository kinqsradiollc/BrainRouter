# ADR-002 — Durable background tasks, attachments & local telemetry

> Status: **ACCEPTED — implemented in 0.4.15 (workflow-gaps pass).**
> Date: 2026-06-18. Covers the durable background-task model, plan-revision and
> review-as-task, BrainRouter-native attachments, and local-first telemetry.

## Context

The 0.4.15 requirement-first workflow shipped plan approval/history, reviews,
annotations, and artifacts, but several flows were not real *background work*:

- Plan **“Request changes”** only drafted feedback into the composer — no task
  ran, nothing was tracked, and the plan was not revised.
- **Review** ran synchronously on the host with no visible task, progress, or
  transcript.
- The only task surface was the **live in-process fleet** (`collectRunningTasks`)
  plus ephemeral React state for finished tasks — nothing survived a host reload
  or workspace/session switch.
- The sidebar **collapsed** a workspace on switch and derived running indicators
  only from the selected session's live turns.
- There was **no attachment** ingestion and **no telemetry** anywhere.

## Decision

1. **One durable task model.** `BackgroundTaskRecord` (in `packages/types`) is the
   single contract for plan revisions, reviews, verification, attachment jobs,
   workflows, and agents. It is workspace-scoped (file-backed at
   `…/cli/backgroundTasks.json`), each record carrying `sessionKey` and optional
   `requirementId`/`planId`/`artifactId`/`attachmentId`, a phase log, status,
   timestamps, a transcript ref, and `linkedMemoryIds`. The CLI
   `backgroundTaskStore` owns it; the desktop host is an adapter. Orphaned active
   tasks reconcile to `failed` on boot (the host owns the work in-process).

2. **Plan revision and review run as tasks.** The host creates a task, streams
   `task-event`s (a new agent-protocol event), runs a dedicated non-prompting
   agent under an *internal* session key (so its turn transcript becomes the
   task's conversation), and on completion updates the plan/review, writes a
   `revised` plan-history snapshot (plan), persists findings + stale state
   (review), and captures memory — all provenance-linked. The live fleet and the
   cross-workspace dashboard merge durable active tasks so indicators come from
   global state and survive switches/reload.

3. **Attachments are first-party records.** `AttachmentRecord` + the CLI
   `attachmentStore` preserve the original blob and capture extracted
   text/metadata (dependency-free PNG/JPEG/GIF/WEBP/BMP dimension sniffing and
   best-effort PDF text). Ingestion is one service (`attachments/ingest`) used by
   the CLI `/attach` command and the desktop drag-drop/picker; every attachment
   is captured to memory so it is recallable as session context.

4. **Telemetry is local-first.** A `telemetry/` layer (contracts · port · file
   adapter · service) appends lifecycle + latency events to a local JSONL log
   only — no network, metadata/counters only, never content. Enabled by default,
   disabled with `cli.telemetry.enabled = false`.

## Verification scoping (follow-up)

A turn's verification (build/test/typecheck/lint) must run in the workspace that
was edited and survive a workspace switch, and the runtime guardrail must fire
precisely:

- **Runs in the edited workspace, survives switches.** Verification runs inside
  the agent turn, which executes in that workspace's pooled host; the host pool
  keeps a busy host alive (never reaped while running), so the work — and its
  task — stay in the edited workspace even after the user switches away. The
  host observes each main turn's tool stream (a new `observeTurnEvent` hostCore
  hook, tagged with the turn's own session key) and records each verify command
  as a durable `verification` task (kind `verification`), keyed by
  workspaceRoot + sessionKey + task id, with the command + output as its
  reopenable transcript. Running tasks show for non-active workspaces (sidebar +
  dashboard merge); completed/failed ones show in the panel's "recently
  finished" list.
- **Guardrail precision.** `classifyForVerification` was narrowed so only actual
  file writes (edit tools, or a clearly file-writing shell command) count as
  "mutated" — a read-only command (`git status`, `ls`, `grep`) no longer trips
  it, and because the gate only evaluates at a turn's end, a workspace/session
  switch (which runs no turn) can never fire it. `decideVerification` adds
  docs-only / config-only detection: a turn that wrote only `.md`/`.json`/`.yml`/…
  is asked to state that no verification was required rather than to run a check.

## Consequences

- BrainRouter memory stays the source of truth; durable stores hold typed
  workflow state and write reusable decisions/evidence into memory. No parallel
  memory/session/workflow store was created.
- New cross-cutting code lives in clear layers (`packages/types` contracts, CLI
  `telemetry/` + `attachments/`, `state/` stores) instead of growing the host or
  panels. The desktop host stays an adapter over the shared CLI services.
- Real-LLM / real-Electron / real-MCP execution of these paths is the operator's
  to validate; everything testable without them is covered by unit/integration
  tests and renderer render-health checks.

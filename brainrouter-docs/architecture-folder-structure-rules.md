# Architecture and Folder Structure Rules

Use this document when adding cross-cutting product work to BrainRouter. It is
especially relevant for 0.4.15 requirement-first workflow, durable plans/tasks,
artifacts, review, verification, Desktop polish, and memory-backed provenance.

## Non-negotiables

- BrainRouter memory stays central. Do not build a parallel memory, session, or
  workflow-memory system.
- `brainrouter/`, `brainrouter-cli/`, and `brainrouter-desktop/` must follow the
  same layered ownership model, even when their exact folder names differ.
- New features should improve boundaries; do not do cosmetic folder moves.
- No product files, docs, UI labels, code comments, or user-facing strings should
  name external reference projects.
- Do not copy external source code verbatim.
- Do not grow new god files. Keep orchestration in services, data rules in
  domain modules, and shell/UI glue in adapters or presentation folders.

## Reference Adoption Policy

Reference projects are long-term research material. They are allowed and
expected to inform BrainRouter architecture, UX, workflow, and implementation
choices. The boundary is ownership: references can teach patterns, but the final
design must become BrainRouter's own architecture, naming, contracts, and code.

When using a reference project:

1. Inspect BrainRouter first and identify the real local gap.
2. Inspect the reference for behavior, folder boundaries, runtime seams, tests,
   and UX flows.
3. Translate the finding into BrainRouter-native terms: a contract, service,
   domain model, port, adapter, panel, workflow, or memory integration.
4. Implement from scratch in BrainRouter style.
5. Keep any reference names out of product files, user-facing strings, comments,
   changelogs, and release docs unless the file is explicitly a private
   comparison or reference-router artifact.

This lets BrainRouter keep learning from many references over time while still
building a coherent first-party architecture.

## Target Shape

The intended destination is a clear modular runtime tree, not the current
mixed-growth layout. New and refactored code should converge on folders like
these wherever they apply:

```text
src/
  adapters/
  attachments/
  cache/
  cli/
  config/
  contracts/
  delegation/
  domain/
  hooks/
  loop/
  memory/
  ports/
  prompt/
  review/
  server/
  services/
  shared/
  skills/
  telemetry/
```

Not every package needs every folder. The rule is to choose the matching owner
instead of adding feature logic to whatever file is already nearby. For example,
agent-loop policy belongs in `loop/` or `services/`, memory capture and recall
belongs in `memory/`, stable payloads belong in `contracts/`, and concrete
filesystem/git/shell/provider implementations belong in `adapters/`.

## Layer Model

| Layer | Owns | Must not own |
|---|---|---|
| `domain/` | Pure models, state transitions, validation-independent decisions. | Filesystem, process, HTTP, React, Ink, Electron, MCP clients. |
| `contracts/` | Wire/event/store payloads, schemas, type guards, stable IDs. | Runtime side effects or UI rendering. |
| `ports/` | Interfaces for memory, git, filesystem, shell, sessions, providers, workflow, interaction. | Concrete implementation details. |
| `adapters/` | Concrete implementations of ports. | Product policy or workflow decisions. |
| `services/` | Application use cases that coordinate ports and domain logic. | UI components or low-level command parsing. |
| `memory/` | Capture, recall, provenance linking, memory classification integration. | A replacement state store for requirements/tasks/artifacts. |
| `workflow/` | Requirement-to-plan, task progression, verification flows. | UI layout, command parsing, raw persistence details. |
| `review/` | Review finding lifecycle, gates, status transitions, verification inputs. | Git command execution details unless hidden behind a port. |
| Presentation | CLI commands, TUI widgets, Desktop panels/components. | Durable business logic. |

Dependency direction should be:

```text
domain <- contracts <- ports <- services <- presentation
                         ^          |
                         |          v
                      adapters ---- side effects
```

The practical rule: domain modules should be easy to unit-test without mocks.
Services may use mocked ports. Adapters need integration-style tests when risk
is non-trivial.

## `brainrouter/` Main Memory Server

`brainrouter/` owns the MCP server, memory engine, memory agents, API routes, and
tool definitions. It is not a dumping ground for CLI/Desktop workflow state.

Keep these boundaries:

- Prefer a modular shape under `brainrouter/src/` as memory-server work grows:
  `contracts/`, `domain/`, `ports/`, `adapters/`, `services/`, `memory/`,
  `server/` or `api/`, `tools/`, `review/`, `workflow/`, and `shared/` where
  those owners become real.
- `brainrouter/src/memory/` owns durable reusable knowledge: cognitive records,
  scenes, working memory, tree summaries, provenance, memory agents, recall, and
  capture pipelines.
- `brainrouter/src/api/` owns HTTP/API routes and middleware.
- `brainrouter/src/tools/` owns MCP tool registration and tool surfaces.
- `brainrouter/src/integrations/` owns external service integration boundaries.
- `brainrouter/src/scripts/` owns operational scripts only.

When adding requirement/task/artifact/review/verification memory support:

- Add memory classifications, capture events, recall filters, and provenance
  links through the existing memory engine.
- Store durable workflow state in typed stores owned by the relevant app/runtime
  layer, then write reusable decisions and evidence into BrainRouter memory.
- Never import Desktop or CLI presentation modules into `brainrouter/`.
- Do not let memory code depend on Electron, Ink, React, or command handlers.
- If a new MCP/API tool is needed, keep its schema/contract stable and put
  business logic behind a service rather than inside the route/tool handler.

## `brainrouter-cli/`

The CLI owns terminal/headless execution, local agent runtime, orchestration,
tool execution, session state, and command rendering. New workflow logic should
not live directly inside command handlers.

Preferred structure for new or refactored work:

```text
brainrouter-cli/src/
  contracts/
  domain/
  ports/
  adapters/
  services/
  memory/
  workflow/
  review/
  cli/
  shared/
```

Rules:

- CLI command handlers parse user intent and call services.
- Workflow services own requirement clarification, task progression, artifact
  creation, review verification, and durable plan/task coordination.
- Git, filesystem, shell, memory, provider, and session access must go through
  ports when used by reusable services.
- Existing folders such as `agent/`, `orchestration/`, `runtime/`, `state/`,
  `prompt/`, and `memory/` may remain, but new cross-cutting work should be
  extracted into clearer layers instead of expanding those folders blindly.
- Preserve existing slash command behavior while moving internals.

## `brainrouter-desktop/`

Desktop owns the Electron shell, renderer UI, host bridge, panels, and local
workflow presentation. It should not own core workflow policy.

Preferred structure for new or refactored work:

```text
brainrouter-desktop/src/
  domain/
  contracts/
  adapters/
  services/
  features/
    requirements/
    tasks/
    artifacts/
    review/
    memory-context/
    write/
  panels/
  components/
  lib/
```

Rules:

- `App.tsx` coordinates top-level layout and state wiring only.
- Feature folders own feature-specific UI, local reducers, selectors, and view
  models.
- Panels compose features; they should not contain persistence or workflow
  policy.
- `lib/` is for genuinely generic helpers only. If helper names mention a
  feature, move them under that feature.
- Electron adapters and IPC code must stay out of pure UI/domain modules.
- Desktop reads and writes durable plans/tasks through the shared source of
  truth, not React-only state.

## Shared Contracts

Use shared packages when a concept crosses process or package boundaries.

- `packages/agent-protocol/` owns agent-host event and command vocabulary.
- `packages/types/` owns shared public/data types used by multiple packages.
- Add guards/tests for any new wire payload.
- Keep protocol additions backward-compatible where existing clients may still
  consume older events.

## Required Workflow State Rules

Requirement-first work must use durable, linkable state:

- Requirements link to sessions, tasks, artifacts, review findings, files, and
  memory IDs.
- Plans/tasks are scoped by workspace and session key, and by requirement ID
  when applicable.
- Plan updates must persist immediately; closing/reopening Desktop must restore
  the selected session's plan.
- Switching sessions must never show another session's plan.
- Review findings and verification evidence must be durable and linkable to
  requirements/tasks/memories.
- Reusable decisions and evidence must be captured into BrainRouter memory.

## Git and Workspace State Rules

Branch/workspace state is live environment state, not durable session truth.

- Read branch from the actual repository/worktree when rendering status, prompt
  context, Desktop environment cards, review panels, and before starting turns.
- Support linked worktrees where `.git` is a file pointing to the real gitdir.
- Watch or poll `.git/HEAD`, `refs/heads`, packed refs, and worktree gitdir
  files as needed.
- Cache only with invalidation. A branch shown to the user must not be stale
  after an external branch switch.

## Refactor Checklist

Before a structural change:

1. Identify the current owner and the desired owner.
2. Extract pure domain/contracts first when possible.
3. Add or preserve tests around behavior.
4. Move side effects behind ports/adapters.
5. Keep compatibility shims if callers are numerous.
6. Remove the shim only after all callers migrate.

Do not merge a structural PR that only moves files and makes future behavior
harder to trace.

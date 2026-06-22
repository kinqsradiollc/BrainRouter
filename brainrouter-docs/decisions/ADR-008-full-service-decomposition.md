# ADR-008 — Full service decomposition: every capability a bounded, deploy-optional service-module

**Status:** proposed (0.4.16) · **Refines:** [ADR-006](ADR-006-service-decomposition-map.md) · **Builds on:** [ADR-003](ADR-003-core-package-extraction.md), [ADR-004](ADR-004-backend-modularization.md), [ADR-005](ADR-005-service-capable-runtime.md)

> Decompose **all** of `packages/core` and `brainrouter/` into bounded
> **service-modules** — every capability gets its own module + typed port,
> embed-by-default and flippable to a network service per-module (ADR-005). The
> goal (easy maintenance + a clean Atlas) comes from the **module** boundary;
> ADR-006's driver test now decides only **when a module runs as its own
> process**. *Everything becomes a service; not everything becomes a separate
> deployment on day one.*

## Context

The direction is "everything multi-service, for maintainability, and so it reads
cleanly in Atlas." ADR-006 was conservative — it only promoted four units to
*network services*. That left most of the engine looking monolithic.

The resolution is to recognise **"service" has two independent axes**, and the
earlier ADRs collapsed them:

| Axis | What it is | When to do it | What it buys |
|---|---|---|---|
| **Module** | a bounded folder/package + a typed **port** (interface) | **always** — for every capability | maintainability, testability, and a **clean Atlas node/layer per unit** |
| **Process** | a separately **deployed** network service | only when a **driver** fires (ADR-006: security / scale / shared-state / async / policy) | independent deploy + scale — at the cost of the distributed-systems tax |

Conflating them forces a false choice (monolith *or* 40 network processes).
Separating them gives the stated goal in full: **fully decomposed structure
now**, **selective deployment later**, no big-bang, no desktop regression.

### Why this is the Atlas-friendly answer

Atlas derives layers deterministically from the package/directory structure
([ADR-007 builder change](ADR-007-postgres-memory-store.md) lineage / the layer
derivation). So **every module we carve out renders as its own clean box**, and
cross-module imports become the service graph. The more thoroughly we modularise,
the friendlier and more legible Atlas gets — the decomposition *is* the diagram.

## Decision

**Module axis — apply to everything.** Each capability below becomes a bounded
module (own folder, later its own package if an external importer needs it)
behind a typed port, following the ADR-003/004 mechanic (leaf-first, re-export
shims, one green PR). **Deployment axis — gated.** A module runs as its own
process only when an ADR-006 driver fires; otherwise it stays embedded and is
reached in-process. One config knob (ADR-005) flips any module embed↔remote.

### `packages/core` — service-modules

| Module | Port | Deploy as own process? |
|---|---|---|
| `agent` (runtime/turn loop) | `IAgentRuntime` | later — headless runtime (D3/D4), high coupling |
| `provider` (LLM gateway) | `IModelGateway` | **yes** — D5/D3/D2 |
| `exec` (sandboxed run) | `IExecService` | **yes** — D1 security |
| `orchestration`+`worker`+`background`+`schedule` (jobs) | `IJobService` | **yes** — D4/D2 |
| `memory` (client bridge to the brain) | `IMemoryClient` | n/a — calls the brain service |
| `atlas` | `IAtlasService` | rides the brain (ADR-005 Phase 3) |
| `tool` · `mcp` · `prompt` · `context` · `session` · `workflow` · `review` · `annotation` · `artifact` · `requirement` · `track` · `goal` · `task` · `usage` · `telemetry` · `attachment` · `lsp` · `extension` · `pack` · `hooks` · `command` · `config` · `storage` · `git` · `worktree` · `workspace` · `util` | one port each | **no** — bounded in-process modules (no driver); become services only if a driver appears |

### `brainrouter/` (the brain) — service-modules

| Module | Port | Deploy as own process? |
|---|---|---|
| brain runtime (memory + cognition) | `IMemoryService` (exists, ADR-004) | **yes** — the umbrella service (ADR-005) |
| `memory/store` (SQLite \| Postgres) | `IMemoryStore` (exists) | DB is external (ADR-007) |
| `memory/{reranker,recall,embedding}` (retrieval) | `IRetrievalService` | **yes, later** — D2/D3 |
| `memory/{pipeline,compression,scheduler}` (cognition workers) | `IJobService` consumer | with the jobs tier |
| `tools` · `api` · `transport` · `contracts` · `memory/{graph,tree,lessons,blackboard,working,source,governance,vault}` | ports within the brain | **no** — brain-internal modules behind `IMemoryService` |

> Net: **~40 bounded modules**, each its own Atlas box; **~5 process boundaries**
> when their drivers fire (provider gateway, exec sandbox, jobs tier, retrieval,
> + the brain itself), DB external. Anything not yet ported is a leaf to extract.

## Migration order

1. **Ports + folders first** (structure) — leaf-first per ADR-003/004; every
   capability gets a port + a clean module boundary. This alone delivers the
   maintainability + the clean Atlas; ship it incrementally, one green PR per
   module. **No deployment change.**
2. **Deploy transports** (process) — add the embed-or-remote transport (ADR-005)
   to a module **only** when its driver fires, starting with the provider gateway
   and the brain.
3. **Atlas reflects it for free** — as modules land, the graph separates; add a
   service-level Atlas view (group by module/port) so the architecture is
   self-documenting.

## Alternatives considered

- **Deploy everything as a network service now.** Rejected: no driver behind most
  units; imports the full distributed tax (transport, auth, tracing, failure
  modes) ~40×; regresses the in-process desktop. It makes maintenance *harder*,
  the opposite of the goal — the module axis already delivers the win.
- **Stop at ADR-006's four services.** Rejected: it leaves the structure looking
  monolithic, which is the actual complaint. ADR-008 extends decomposition to
  *everything* at the module axis while keeping deployment sane.

## Consequences

- **Maintainability:** every capability is an isolated, ported, separately
  testable unit — the thing that actually makes a large codebase tractable.
- **Atlas:** each module is a clean node/layer; cross-module edges are the live
  service map — the decomposition documents itself.
- **Deployment stays sane:** process boundaries appear only with a driver, so we
  scale out exactly where it pays and nowhere it doesn't; the desktop stays fast
  and embedded.
- **Reversible + incremental:** it's N leaf extractions (each a green PR) plus a
  transport-per-module switch — no big-bang, abandonable at any point.
- **Cost:** a sustained extraction effort (tracked in `Tasks.md`); ports add a
  little indirection (worth it for the boundary).

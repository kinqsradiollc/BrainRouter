# ADR-006 — Service decomposition map: which capabilities earn their own service

**Status:** Closed — partially implemented, remainder superseded (verified 2026-08-16: gateway (#1) and jobs (#4) run as real processes; exec (#2) and retrieval (#3) exist as ports only — those splits were **declined** by ADR-011, and any future split now goes through ADR-041 D12's service-profile mechanism rather than this map) · **Supersedes:** none · **Builds on:** [ADR-005](ADR-005-service-capable-runtime.md) (service-capable runtime)

> ADR-005 said *how* we go multi-service (promote existing ports to an optional
> network transport; embed by default). This ADR answers *what* — a grounded
> catalog of every capability and whether it **earns its own service**, judged by
> explicit **isolation drivers** rather than by splitting for its own sake. The
> short list of net-new services beyond the brain: an **LLM/provider gateway**, a
> **sandboxed execution service**, a **retrieval/embeddings service**, and an
> **async worker/jobs tier**. Everything else stays a library, a brain
> subsystem, or a client.

## Context

The codebase splits cleanly into ~36 core domains and 8 brain domains (file ·
LOC survey, 2026-06-23):

**`packages/core/src` (engine, embedded in CLI + desktop host):**

```
agent          8485    orchestration 4555    workflow      1527    track   1459
exec           1449    provider      1378    session       1434    util    1247
memory         1199    attachment    1156    mcp           1183    prompt  1176
config         1275    context        663    goal           746    review   409
+ ~24 smaller domains (annotation, artifact, requirement, schedule, task,
  telemetry, storage, worktree, hooks, lsp, command, usage, git, workspace, …)
```

**`brainrouter/src` (the brain / MCP server):**

```
memory 16780 (store 5376 · pipeline 1330 · llm 691 · source 523 · scheduler 485
              · compression 536 · recall 399 · reranker 293 · working 477 · …)
tools  4541   api 2414   transport 429   contracts 81   integrations 273
```

### The principle: a capability earns a service only if it has an isolation driver

ADR-005 established **service-capable, in-process-default**. A capability is
*promoted* to its own service only when it has at least one concrete driver —
otherwise it stays in-process (a library, a brain subsystem, or client code):

- **D1 — Security isolation:** runs untrusted / agent-generated code or commands.
- **D2 — Independent scaling / distinct resource profile:** CPU/GPU/model-heavy,
  bursty, or otherwise wants to scale on a different curve than the UI.
- **D3 — Shared state across clients / tenants:** one authoritative copy serving
  many clients (not one per laptop).
- **D4 — Separate lifecycle / async:** long-running, durable, or scheduled work
  decoupled from a request/turn.
- **D5 — Cross-cutting policy + reuse:** every component routes through it and it
  carries policy (keys, quota, rate limits, fallback, cost, audit).

"Split everything" is rejected on the same grounds as ADR-005: it turns library
imports into network calls and imports the distributed-systems tax with no
driver behind it.

## Decision

Adopt this decomposition map. The **brain** (memory + cognition + Atlas) is the
umbrella service from ADR-005. **Four net-new services** are justified by the
drivers above; everything else stays in-process.

### Net-new service candidates (ranked by driver strength)

| # | Service | Source domains | Drivers | Notes |
|---|---|---|---|---|
| 1 | **LLM / Provider gateway** | `core/provider` (1.4k) + `brainrouter/memory/llm` (691) | **D5, D3, D2** | BrainRouter's namesake function. One authenticated egress for *all* model calls — routing, fallback, rate-limit, key custody, cost + token telemetry, caching. Highest leverage: every other component already funnels through it. |
| 2 | **Sandboxed execution service** | `core/exec` (1.4k — `sandbox`, `commandPolicy`, `dangerousCommand`, `destructiveCommandGuard`, `pathPolicy`) | **D1** | Runs agent-generated shell/commands. The textbook reason to isolate: untrusted execution belongs behind a hard boundary (separate process / container / VM), not in the host that holds the user's session + keys. |
| 3 | **Retrieval / embeddings service** | `brainrouter/memory/{reranker,recall,store/embedding}` (~1k) | **D2, D3** | Vector search + reranking is the model/CPU-heavy hot path of recall; it scales on a different curve than the brain's CRUD and is the usual seam to put behind its own service in a RAG system. Extract *from within* the brain once the brain is remote (ADR-005 Phase 3+). |
| 4 | **Async worker / jobs tier** | `core/{orchestration,worker,background,schedule}` + `brainrouter/memory/{scheduler,pipeline}` | **D4, D2** | Durable + scheduled + multi-agent work: deferred cognitive extraction, Atlas enrichment, cron/`/schedule`, federation fan-out. A worker tier consuming a queue, scaled independently of request handling. |

### What explicitly stays in-process (no driver)

- **Libraries / contracts (ADR-005):** `types`, `agent-protocol`, `sdk`, `hooks`,
  plus cross-cutting `config`, `util`, `git`, `storage`, `telemetry`, `context`,
  `prompt`, `command`, `usage` — imported, never networked.
- **Brain subsystems (part of the brain service, not separate):** `memory/store`,
  `pipeline`, `graph`, `tree`, `lessons`, `blackboard`, `compression`, `source`,
  `working`, `vault`, `governance`; `tools`; `api`; `session`/transcript. These
  are *inside* the ADR-005 brain, behind `IMemoryService` — decomposing them
  further (beyond #3) buys nothing until the brain itself is a bottleneck.
- **Workflow features (CRUD over brain stores):** `review`, `annotation`,
  `artifact`, `requirement`, `track`, `goal`, `task` — thin domain logic over
  persisted records; they ride the brain, not their own services.
- **Client-local concerns:** `mcp` (client pool), `attachment`, `lsp`,
  `extension`, `pack`, `worktree`, `workspace`, `atlas` consumption — these run in
  the CLI/desktop client; Atlas *building/enrichment* rides the brain (ADR-005
  Phase 3).
- **Agent runtime (`core/agent`, 8.5k) — stays embedded for now.** It is the turn
  loop, tightly coupled to client streaming via `agent-protocol`. A *headless
  execution service* (cloud agents) is a real future option (D3/D4) but is the
  **lowest-priority** extraction: high coupling, and the desktop's in-process
  host is a deliberate strength. Revisit only when remote/cloud agents are a
  product requirement.

### Sequencing (each behind a port, embedded-default, additive)

1. **Brain remote** — ADR-005 Phase 1 (prerequisite; everything else assumes a
   remote brain exists).
2. **LLM/provider gateway** — extract `provider` behind a `ModelGateway` port; in
   embedded mode it's a direct call, in remote mode an authenticated proxy.
   Highest ROI, unblocks shared keys/quota/cost.
3. **Sandboxed execution** — move `exec` behind an `ExecService` port; default
   in-process, opt-in to a container/VM sandbox. Security win, independently
   shippable.
4. **Worker/jobs tier** — formalize a queue + worker behind a `JobService` port
   (cognition, enrich, schedule, federation consume it).
5. **Retrieval service** — split recall's vector+rerank out of the brain behind a
   `RetrievalService` port once the brain is remote and retrieval is a measured
   hot path.

Each step follows ADR-005's mechanic: a **port + an optional transport**, the
in-process path stays default and CI-tested, one green PR per step.

## Alternatives considered

### Extract every domain into its own microservice
- **Rejected** (same as ADR-005): no driver behind most domains; networks the
  library layer; multiplies deploy/observability surface. The driver test exists
  precisely to stop this.

### Stop at the brain (ADR-005 only), extract nothing further
- Pros: smallest surface.
- Cons: leaves the genuine wins on the table — a shared **provider gateway**
  (keys/quota/cost across the org) and a **sandboxed executor** (security) have
  clear drivers independent of the brain.
- **Rejected:** the four named services each clear the driver bar.

### Split the agent runtime first (headless execution service)
- **Rejected as an early step:** highest coupling (streaming via
  `agent-protocol`), and it would regress the in-process desktop. It's catalogued
  as a *later* option contingent on a cloud-agent requirement, not a now.

## Consequences

- A **principled catalog**: four net-new services with named drivers, plus an
  explicit "stays in-process" list — so future "should X be a service?"
  questions have a test (the five drivers) instead of taste.
- The **provider gateway** and **sandbox** are independently valuable and can ship
  on their own timelines (they don't strictly depend on the brain being remote,
  though they slot cleanly into ADR-005's port model).
- **Cost is bounded:** every extraction is a port + optional transport, embedded
  by default — same low-regret, reversible shape as ADR-005. Nothing here mandates
  a distributed deployment; it makes one *possible*.
- **Re-evaluation triggers** are explicit: the brain becoming a bottleneck
  (→ retrieval split), a cloud-agent requirement (→ headless runtime), or
  org-shared model budgets (→ provider gateway first).

# ADR-005 — Service-capable BrainRouter: promote the brain to a deployable runtime (remote-or-embedded)

**Status:** Accepted — implemented (verified 2026-08-16: `cli.brainUrl` + remote pool, Atlas-over-MCP, tenancy, deployable brain image all shipped; the "embedded stays default" premise was later narrowed by ADR-007's SQLite removal) · **Supersedes:** none · **Builds on:** [ADR-003](ADR-003-core-package-extraction.md) (core extraction), [ADR-004](ADR-004-backend-modularization.md) (backend service ports)

> Make BrainRouter's **stateful capabilities** — the brain (memory recall +
> cognition), Atlas (the codebase knowledge graph), and orchestration/federation
> — runnable as a **standalone service** that clients (CLI, desktop, agents,
> dashboard) connect to **remotely _or_ embed in-process**, with the fast
> in-process mode kept as the **default**. Promote the boundaries that already
> exist (MCP + `agent-protocol` + the ADR-004 service ports) to network
> boundaries **where it pays** — do **not** turn libraries into network calls,
> and do **not** do a microservices big-bang.

## Context

"Multi-service" is being considered for the whole product, not just Atlas. The
honest engineering question is **which capabilities benefit from being
independent, network-addressable services, and which are better in-process** —
because BrainRouter today is three different kinds of module wearing one
monorepo.

### Where we already are (the seams exist)

- **The brain is already a service boundary.** `brainrouter/` is an MCP server;
  ADR-004 put a `MemoryService` / `IMemoryStore` **port** between transport and
  the engine. That is the single most important fact here — the contract for a
  remote brain is mostly already drawn.
- **`packages/agent-protocol` is already a typed event/command bus** between the
  agent runtime and any client (the desktop's whole renderer talks to its host
  through it).
- **The desktop already runs the agent out-of-process** (a `utilityProcess`
  host per workspace) — a 2-tier system, just in-process today.
- **Atlas (0.4.16)** added a per-workspace codebase graph (build / enrich /
  impact / coverage / review) consumed by both CLI and desktop — a capability
  that is obviously worth sharing rather than rebuilding per client.
- **Federation** already implies multi-agent, cross-process coordination.

### The pressure to go service-oriented

- Teams want **shared, persistent brains** (one memory + one Atlas per repo/org,
  not one per laptop).
- The **LLM-heavy work** (recall reranking, cognitive extraction, Atlas
  enrichment) benefits from **scaling independently** of any UI and from a real
  **cloud** deployment story.
- The **agent itself** should be able to query memory and Atlas **over the wire**
  so it codes architecture-aware and the review-before-commit loop can run
  automatically, not only when a human opens a panel.

### The constraint (why "everything a service" is wrong)

- The **in-process design is a deliberate asset** — the desktop is fast because
  it embeds the runtime with zero network tax (a decision made when the
  CLI-subprocess-scraping alternative was explicitly rejected). A microservices
  rewrite would regress that and import the full distributed-systems tax
  (transport, auth, consistency, observability, deploy orchestration).
- **`types` / `agent-protocol` / `sdk` / `hooks` are libraries (contracts).**
  Turning a type import into a network call is pure cost with no benefit.

## Decision

Adopt **"service-capable, in-process-default."** Classify every module into one
of three fates and promote the existing ports to an optional network transport.

| Kind | Examples | Fate |
|---|---|---|
| **Contracts / libraries** | `types`, `agent-protocol`, `sdk`, `hooks` | **stay libraries** — imported, never called over a network |
| **Stateful capabilities** | brain (memory recall + cognition), **Atlas**, orchestration/federation | **become the service** — deployable, shareable, scalable |
| **Clients** | CLI, desktop, dashboard | **stay clients** — connect to a brain (embedded by default, remote when configured) |

The product becomes **one deployable "BrainRouter server"** that a client either
**embeds** (today's mode, the default) or **connects to remotely**. Five thrusts:

1. **Boundary classification — codified.** Write the library/service/client split
   into the contracts so it stops being implicit. No library gains a network
   dependency.
2. **Remote transport for the brain.** The brain already speaks MCP over
   stdio/in-process; add an **authenticated network transport** (HTTP+SSE or
   WebSocket) over the existing `IMemoryService` + tool ports. **No new business
   logic** — transport only.
3. **Embedded-or-remote client contract.** A single connection abstraction (the
   CLI/desktop `McpClientPool` already abstracts the client) selects
   **in-process vs remote** from config; in-process stays the default; remote is
   opt-in via one knob.
4. **Atlas-as-service.** Expose Atlas (build / query / impact / coverage /
   enrich) as **brain tools** (and optionally HTTP), so the agent and any remote
   client share **one** graph per repo instead of each rebuilding it. This is
   also the answer to the Atlas-specific "multi-service" question.
5. **Tenancy + auth.** Reuse the backend's already-clean JWT / API-key
   middleware (ADR-004) and its 12-factor env config (ADR-004 Phase 5) as the
   **server deployment contract**; isolate brain state per tenant.

### Migration mechanic (every phase)

- **Additive, not a rewrite.** Each phase adds a transport or a config knob; the
  embedded path is never removed or slowed.
- **Embedded stays default + first-class.** CI must exercise **both** the
  embedded and remote paths so the local desktop never silently regresses.
- **One green gate per PR.** `npm run build && npm test` across the affected
  packages must pass before merge; each phase is one reviewable PR.
- **Behaviour-preserving.** Remote must be behaviourally identical to embedded
  for the same inputs; product changes ride separately.

## Migration order (leaf-first, numbered phases)

- **Phase 1 — Remote-brain spike.** Run `brainrouter/` as a standalone process
  with an authenticated network MCP transport; point the CLI/desktop at it via
  one config knob (`cli.brainUrl` / `BRAINROUTER_BRAIN_URL`). Goal: prove
  **remote ≡ embedded** behaviourally with near-zero rewrite. Default stays
  embedded. *Highest signal, lowest risk — do this first.*
- **Phase 2 — Connection abstraction.** Unify embedded/remote behind the client
  pool: health checks, reconnect, and **graceful fallback to embedded** if the
  remote is unreachable, so a misconfigured URL never bricks the app.
- **Phase 3 — Atlas-as-service.** Brain tools for Atlas build/query/impact/
  enrich; the agent and remote clients share one per-repo graph (per-workspace
  store already exists). Enrichment runs server-side where the model lives.
- **Phase 4 — Tenancy / auth / observability.** Per-tenant isolation, auth on
  the remote transport, rate limiting, and tracing — the prerequisites for any
  shared/hosted deployment.
- **Phase 5 — Cloud packaging (optional/later).** A deployable server image and
  the dashboard as a first remote client. Only once Phases 1–4 prove out.

## Alternatives considered

### Full microservices (split every capability into its own networked service)
- Pros: maximal independent scaling/deploy; language flexibility; team boundaries.
- Cons: turns libraries into network calls; imports the full distributed-systems
  tax; **regresses the in-process desktop** that is a core product strength.
- **Rejected:** no current need justifies the complexity, and it throws away the
  embedded fast-path. "Service-capable" gets ~90% of the benefit at a fraction of
  the cost and stays reversible.

### Status quo (embedded-only, forever)
- Pros: simplest; nothing to build.
- Cons: blocks shared/team brains, the cloud story, and agent-over-the-wire; the
  service seams (MCP, ports, protocol) already exist and are being wasted.
- **Rejected:** the demand is real and the seams are already paid for.

### A standalone Atlas-only service (first)
- Pros: ships the most-requested shared capability fastest.
- Cons: a second bespoke server + transport + auth, parallel to the brain's.
- **Rejected as the _first_ move:** Atlas should **ride the brain's transport**
  (Phase 3), not grow its own server. Revisit only if Atlas needs to scale
  independently of the brain.

## Consequences

- One deployable **BrainRouter server**; clients **embed by default**, connect
  **remotely when configured** — multi-tenant and cloud become possible **without
  a rewrite**.
- The **agent gains architecture-awareness**: it can query memory + Atlas over
  the wire, making review-before-commit and impact analysis part of its own loop.
- **New surface to own:** a network transport + auth + observability. Mitigated
  by reusing ADR-004's middleware and keeping the transport logic-free.
- **Two paths to test forever:** embedded and remote. Accepted cost; encoded as a
  CI requirement so embedded never silently regresses.
- **Low-regret / reversible:** the change is additive (a transport + a config
  knob). Embedded-only remains fully intact, so we can stop after any phase.

## What explicitly stays as-is

- `types` / `agent-protocol` / `sdk` / `hooks` remain **libraries** (contracts),
  imported — never network calls.
- The **in-process desktop host** (`utilityProcess`) stays the default and the
  fast path; the renderer keeps talking `agent-protocol`.
- The **config-file (CLI/client) vs env (server)** configuration split from
  ADR-004 (Phase 5 investigation) is preserved — clients read `config.json`,
  the deployable server reads `BRAINROUTER_*` env.

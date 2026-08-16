# ADR-001 — Async store via a SQLite worker thread

> Status: **SUPERSEDED (2026-08-16) — the SQLite store this ADR would have made async was removed entirely by the ADR-007 Postgres cutover; an async SQLite worker is moot.**
> Date: 2026-06-07. Covers the 0.4.14 ASYNC-2 + ASYNC-3 workstreams (they are one
> change, not two — see below).

## Context

The memory store (`brainrouter/src/memory/store/sqlite.ts`) uses `node:sqlite`'s
**`DatabaseSync`** — synchronous by design; there is no async `node:sqlite` API.
Every store method runs the query inline on the event loop.

- For the **CLI** and a **low-concurrency MCP server** (the dominant deployment),
  this is fine: requests are effectively serial, so a blocking query blocks
  nothing else.
- Under **many concurrent HTTP clients** (the dashboard at scale), a single heavy
  query — a large recall FTS/vector scan, a bulk `memory_import`, a graph
  expansion — blocks the event loop and stalls *all* in-flight requests.

The network-bound paths (LLM / embeddings / reranker / judge / recall) are
already `async`. ASYNC-1 (shipped) parallelized bulk embedding. The remaining
lever to "stop blocking the event loop" is offloading the **synchronous SQLite
work** itself.

## Decision (proposed)

Move the SQLite store into a **dedicated worker thread** that owns the
`DatabaseSync` connection (SQLite connections are not safe to share across
threads, so ownership must be exclusive). All store access goes through an
**async request/response message bridge**; `IMemoryStore` becomes fully `async`;
every caller `await`s. This single change *is* both ASYNC-2 (the worker) and
ASYNC-3 (the async public API) — the cascade is inseparable.

## Consequences

**Benefit**
- The event loop is no longer blocked by DB work → concurrent HTTP/MCP requests
  are served while a heavy query runs in the worker.

**Cost / risk (why this is deferred, not merge-on-green)**
- **Highest blast radius in the codebase.** ~100 store methods become async +
  ~71 callers (engine, tools, routes, pipelines) + their tests. A subtle
  serialization bug = silent memory corruption for every user.
- **Per-call IPC overhead.** A recall makes *many* store calls (FTS, vector,
  tag lookups, churn, graph). Each becomes a postMessage round-trip + structured
  clone (rows, `Float32Array` embeddings). For a **single** request this *adds*
  latency — the worker trades single-request speed for concurrency. On the CLI
  (serial, single-user) it is **pure overhead with no upside**.
- Transaction semantics (`BEGIN/COMMIT`) must be expressed over the message
  protocol; `sqlite-vec` must load in the worker; error/stack propagation crosses
  the thread boundary.

## Alternatives considered

- **Keep the sync store (status quo).** Correct for CLI + low-concurrency MCP.
  The blocking only bites under heavy concurrent HTTP — not today's main use.
- **Async SQLite engine** (e.g. libsql) — swaps the driver; large dependency +
  migration change of its own.
- **Offload only heavy queries** — infeasible: the connection is single-thread-
  owned, so it's all-or-nothing.

## Recommendation

1. **Ship ASYNC-1** (done) — the safe, high-ROI part of the async track.
2. **Gate, don't globally adopt.** If implemented, the worker store should be
   **opt-in via a flag**, enabled for the HTTP dashboard server under load and
   **off for the CLI** (where it's pure overhead). The async `IMemoryStore` can
   be uniform; the worker-vs-inline backend is the flag.
3. **Implement as its own reviewed, phased effort** with integration tests — not
   a single auto-merged PR into a point release. Reassess priority when
   concurrent-HTTP scaling is a real, measured need.

**For 0.4.14:** this ADR is the deliverable for ASYNC-2/ASYNC-3; the
implementation is deferred pending the go-ahead on the above.

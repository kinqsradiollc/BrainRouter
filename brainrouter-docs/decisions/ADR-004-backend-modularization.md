# ADR-004 — Modularize the `brainrouter/` MCP-server / memory backend

**Status:** Accepted — implemented (verified 2026-08-16: all phases landed; Phase 5 deferred by design; `contracts/` scoped to the HTTP envelope only) · **Supersedes:** none · **Mirrors:** [ADR-003](ADR-003-core-package-extraction.md)

> Do for the backend what ADR-003 did for the CLI/desktop: replace a
> **layer-based, god-file** layout with a **domain-categorized** one, extract
> stable **typed contracts**, put **service ports** between transport and the
> engine, and **consume `@kinqs/brainrouter-core`** instead of re-implementing
> what it already owns — migrated leaf-first with re-export shims so the ~268
> backend files and their tests stay green at every step.

## Context

`brainrouter/` is the cognitive-memory MCP server (the "actual endpoints where
our backend and memory live"): **~268 TS files, ~34k LOC**. It predates ADR-003
and carries the same debt the CLI had before the core extraction.

### Ground-truth findings (4-agent survey, 2026-06-19)

Organized by **layer**, not domain — and two god-files dominate:

- **`memory/store/sqlite.ts` — 3,998 LOC.** One file owns schema, migrations,
  query building, parsing, and CRUD for 13+ memory types plus job scheduling,
  tree ops, graph ops, blackboard, source/vault. No domain seam.
- **`memory/engine.ts` — 1,958 LOC.** A god-facade (46 imports deep) that
  routes/tools call directly; no service boundary.
- **Scattered contracts.** Every MCP tool (46 files) and HTTP route (16 files)
  re-declares its own inline Zod schema; API routes duplicate tool schemas.
  There is no shared, testable, versionable contracts module.
- **Duplication vs `@kinqs/brainrouter-core`.** The backend re-implements LLM
  orchestration (`ModelLLMRunner`), config/env resolution, telemetry, and auth
  crypto — concerns the core package now owns.
- **No service seam.** Routes/tools reach `memoryEngine.method()` and
  `SqliteMemoryStore` directly; `IMemoryStore` exists but isn't used as a port.
- **Tangled transport.** `index.ts` registers 46 tools inline + mixes stdio /
  HTTP / MCP transports; the 666-LOC `chat-completions` route mixes wire
  parsing, SSE streaming, briefing injection, and capture.
- **Clean already:** `api/middleware/*` (auth/validate/rateLimit/scope/
  errorHandler/securityHeaders), JWT crypto, pagination, security headers.

The reference target is `packages/core/src` — ~32 **domain** categories
(`provider/`, `agent/`, `tool/`, `session/`, `memory/`, …) with thin shims.

## Decision

Refactor `brainrouter/` toward the ADR-003 shape, in five thrusts:

1. **Domain-categorized layout** for `memory/` (`capture/ recall/ store/ graph/
   lessons/ blackboard/ tree/ working/ source/ reranker/ scheduler/`), `tools/`
   (a modular registry), and `api/routes/` (domain folders).
2. **Typed contracts** centralized **in-repo** at **`brainrouter/src/contracts/`**
   (wire/DTO/tool Zod schemas + memory domain types) — **no new published
   package**, so the release surface is unchanged and the seam is the
   lowest-risk option. (A package can be promoted later if CLI/desktop ever need
   to import these directly.)
3. **Service ports** — a `MemoryService` port (`IMemoryService`) between
   transport (routes + tools) and the engine; `IMemoryStore` becomes the real
   seam the SQLite adapter implements.
4. **God-file splits** — `sqlite.ts` → focused store modules behind the port
   (`SqlitePersistence / Search / Batch / Job / Graph / Tree / Source /
   Blackboard`); `engine.ts` → a thin facade over `CapturePipeline` /
   `RecallPipeline` / domain ops.
5. **Consume `@kinqs/brainrouter-core`** for LLM/provider orchestration, config,
   and telemetry — delete the backend's duplicate implementations.

### Migration mechanic (every phase, per ADR-003)

- **Leaf-first.** Move/extract a module only after its dependencies have moved.
- **Re-export shims for cross-package / external-importer moves.** When a move
  would strand importers the same PR can't update atomically (e.g. a later
  extraction the CLI/desktop import), the old path becomes
  `export * from '<new path>'`. For a **same-package internal reorg** (Phase 2),
  prefer a **direct import rewrite** instead: the `brainrouter/` build resolves
  every specifier, so a dangling import is a compile error — that gate is
  stronger than a shim and leaves no dead re-export files behind.
- **One green gate per PR.** `npm run build && npm test` in `brainrouter/`
  (plus the core/CLI/desktop gate when a shared package changes) must pass
  before merge. Each phase is one reviewable PR into `release/0.4.15`.
- **Behaviour-preserving.** Splits and reorgs change structure, not behaviour;
  behavioural fixes ride separately.

## Migration order (leaf-first, numbered phases)

- **Phase 1 — Contracts + API cleanups.** Create `brainrouter/src/contracts/`
  and make it the single source of truth for the **HTTP error envelope**
  (`{ error, code, details? }`): `codeForStatus` / `statusForError` move here, the
  terminal `errorHandler` consumes them, and a shared `sendError` helper replaces
  the ~60 hand-rolled `res.status(n).json({ error })` route guards so every error
  response carries a machine `code`. De-duplicate the auth middleware (shared
  `bearerFrom` + API-key attach) while **keeping the three guards distinct** —
  `requireAnyAuth` intentionally trusts a valid JWT without the DB/disabled
  re-check `requireJwt` enforces, so a single mega-factory would either change
  that security behaviour or add obscuring branches. No new package; de-risks the
  seam in-repo. *(Lifting the inline Zod request/tool schemas is deferred: the
  route validators don't duplicate tool schemas, so they migrate with the modular
  tool registry in Phase 6 rather than as low-value relocation here.)*
- **Phase 2 — Memory domain reorg.** Move `memory/*` into domain folders with
  shims (capture/recall/store/graph/lessons/blackboard/tree/working/source/…).
  No logic change.
- **Phase 3 — Store split.** Decompose `sqlite.ts` (3,998 LOC) into capability
  modules behind `IMemoryStore`; `SqliteMemoryStore` composes them. Iterative —
  one capability per PR if needed.
- **Phase 4 — Engine → service.** `engine.ts` becomes a facade over
  `CapturePipeline` / `RecallPipeline` / domain ops behind `IMemoryService`;
  routes/tools call the port, not the engine internals.
- **Phase 5 — De-dup vs core. → DEFERRED (investigated 2026-06-20; see below).**
  Original intent: replace the backend's `ModelLLMRunner`, config loader, and
  telemetry with `@kinqs/brainrouter-core` equivalents. A code-level survey found
  the premise mostly does not hold, so this phase is intentionally deferred
  rather than forced — see **Phase 5 — investigation outcome**.
- **Phase 6 — Transport + tools.** Modular MCP tool registry (auto-discovery,
  no inline registration in `index.ts`); split `index.ts` into
  `bootstrap / http-server / mcp-server / transport`; extract a
  `ChatCompletionOrchestrator` out of the chat-completions route.

## Phase 5 — investigation outcome (2026-06-20)

A file-level survey of `brainrouter/src` against `packages/core/src` shows the
backend does **not** accidentally duplicate core; where they overlap they
**diverge on purpose**, so a wholesale de-dup is **not behaviour-preserving** and
is deferred under this ADR's "one green gate per PR / behaviour-preserving" rule.

- **`ModelLLMRunner` / LLM config — intentional divergence, not duplication.**
  The backend resolves endpoint / API key / model / timeout from
  `BRAINROUTER_LLM_*` **environment variables** — its 12-factor *server*
  deployment contract (same family as `BRAINROUTER_JWT_SECRET`). Core's
  `callOpenAI` takes a structured `LLMConfig` resolved from
  `~/.config/brainrouter/config.json` + the provider catalog — a *CLI* model.
  Swapping the runner would change how the MCP server is configured in
  production. The backend also carries server-only behaviour core lacks
  (LM-Studio unload-retry, local-endpoint timeout stretching).
- **Semaphore / timeout — same logic, different config source.** Behaviourally
  identical except the cap/timeout come from env (backend) vs `config.json`
  (core); not swappable without adopting the config-file model.
- **Telemetry / tracing — nothing to de-dup.** The backend hasn't implemented
  these yet; core's modules are config.json-driven.
- **No existing coupling.** `brainrouter/package.json` depends only on
  `@kinqs/brainrouter-types`, not `@kinqs/brainrouter-core`. Adding the
  heavyweight `core` package to the MCP server to share ~40 LOC of pure helpers
  (`extractChatCompletionText`, `isExternalTimeoutError`) would bloat the
  server's dependency tree for negligible gain — the wrong trade.

**Decision.** Defer Phase 5. The "two LLM runners" are not drift to be merged but
two configuration surfaces (env-server vs file-CLI). A future safe de-dup is
**gated on two preconditions**, to be designed deliberately rather than
mechanically: (1) a backend **env→`LLMConfig` adapter** so the server keeps its
env contract while delegating the HTTP/parse path to a shared runner; and (2) a
**dependency-free shared-util package** (or additions to
`@kinqs/brainrouter-types`) to host genuinely-identical pure helpers — so the
backend never has to depend on the CLI-oriented `core` package. Until then the
small, stable duplication is the cheaper, safer state.

## Consequences

- **Shared memory domain** becomes reusable across the CLI, desktop, and the
  backend itself (a CLI that talks to the engine in-process no longer forks
  logic). (The "two LLM runners" turn out to be two configuration surfaces, not
  drift — see *Phase 5 — investigation outcome*; their de-dup is gated, not
  pursued here.)
- **God-files become reviewable.** A 4k-LOC store split into capability modules
  behind a port is testable and swappable (Postgres/other backends).
- **Risk** is the SQLite split (Phase 3) — highest LOC, most coupling. It is
  deliberately last-but-one, iterative, and gated by the existing engine tests
  (the regression net). Phase 0 de-risks the workspace wiring up front.
- **Rollback:** every phase is shim-backed; reverting a phase's PR restores the
  prior layout with no importer churn.

## What explicitly stays as-is

- `api/middleware/*`, JWT crypto, pagination, security headers — already clean.
- The recall pipeline's *behaviour* (keyword/vector/filepath → reranker → LLM
  judge → graph expansion) — only its *packaging* changes.
- The DB schema + on-disk format — untouched (no data migration).

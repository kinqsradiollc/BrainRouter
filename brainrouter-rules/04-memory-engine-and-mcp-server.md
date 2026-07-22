# 04 — Memory Engine & MCP Server (`brainrouter/`)

The core product: the MCP server, the memory engine, the recall pipeline, and the
tool registry. This is where the security and data-integrity invariants live.

The recall pipeline (see `CLAUDE.md`) runs four stages: keyword/vector/filepath
retrieval → reranker → optional LLM relevance judge → graph expansion.

---

## Engine lifecycle & structure

### 1. Engine methods are thin wrappers over free-function ops modules

`MemoryEngine` method bodies live in `engine/*Ops.ts` (`memoryOps`, `sourceOps`,
`vaultOps`, `benchOps`, `sweepersOps`, `lifecycleOps`, `maintenanceOps`) as free
functions whose first parameter is the engine instance. Those modules must use
`import type { MemoryEngine } from "../engine.js"` (type-only, no runtime cycle).
To reach private engine fields (`synthesisRunner`, `capturePipeline`,
`embeddingService`), define a narrow `EngineInternals` type and cast — do **not**
make the fields public.

- **Why:** a value import of `engine.ts` from an ops module creates a runtime
  cycle; the narrow cast keeps the engine's private surface private.
- **Evidence:** `brainrouter/src/memory/engine.ts:9`, `brainrouter/src/memory/engine/memoryOps.ts:25,37`

### 2. ⛔ Never construct `MemoryEngine` eagerly; use the lazy singleton and await readiness

Tools/routes import the `memoryEngine` proxy (or `getMemoryEngine()`), which
constructs the engine on first property access. Never `new MemoryEngine()` at
module top level. Construction opens a Postgres pool and kicks off async init
(migrations → `initVec` → seed-admin) stored on `engine.ready`; production startup
and tests MUST `await engine.ready` / `engine.init()` before the first
store-using call. `close()` is idempotent, awaits in-flight init before ending the
pool, and after close the instance must not be reused — the proxy lazily rebuilds.

- **Why:** eager construction started stray pools and background sweepers in tests
  and caused teardown races; the store is genuinely async so skipping `ready`
  races migrations.
- **Evidence:** `brainrouter/src/memory/engine.ts:43,758,787`

### 3. ⛔ Always `await` engine methods (they are async / PG-backed)

`res.json(memoryEngine.getStats(...))` type-checks fine but serializes a *pending
Promise* as `{}`, showing 0/NaN/undefined in the dashboard. TypeScript will not
flag this. When touching brain API routes or `src/tools`, grep for unawaited
`memoryEngine.*`.

- **Evidence:** `brainrouter/src/api/routes/memory/stats.ts:8`

### 4. Optional store capabilities are runtime-detected and degrade gracefully

The engine talks to `IMemoryStore`; methods beyond that contract (blackboard,
governance stats, churn lookup) are reached by narrowing at runtime — cast to a
Partial shape and check `typeof store.method === "function"` (or `?.`), returning
an empty/no-op result when absent. New store capabilities follow this pattern
rather than widening `IMemoryStore`, so partial store mocks in tests keep working.

- **Evidence:** `brainrouter/src/memory/engine.ts:533,546`

### 5. Postgres store: SQL in `queries/*.ts` free functions over an `Executor`; class keeps lifecycle only

Per-domain SQL lives in `store/postgres/queries/<domain>Queries.ts` as free
functions taking an `Executor` (rows/one/run/tx primitives) plus a small context
object. `PostgresMemoryStore` itself keeps the `IMemoryStore` surface, connection
lifecycle, and pgvector bootstrap (`cognitive_vec` is created in `initVec(N)` at
runtime because its dimension is embedder-dependent; schema migrations run in
`init()` via the `migrations/` runner). Atomic claims use
`BEGIN` / `SELECT … FOR UPDATE SKIP LOCKED` / `COMMIT`.

- **Note:** SQLite support was removed (ADR-007); the store is pgvector Postgres.
- **Evidence:** `brainrouter/src/memory/store/postgres/PostgresMemoryStore.ts:1`,
  `brainrouter/src/memory/store/postgres/queries/`, `brainrouter/src/memory/store/postgres/migrations`

---

## Security & data-integrity chokepoints

### 6. ⛔ Never trust a client-supplied `userId` — the dispatcher pins it

The CallTool dispatcher force-overwrites any `userId` key present in tool
arguments with the transport's authenticated `defaultUserId` (rewrite an EXISTING
key only, never inject one, so tools whose schema lacks `userId` are untouched).
Memory tools scope SQL to whatever `userId` they receive with **no ownership
recheck**, so new tools must rely on this pin.

- **Why:** the cross-tenant IDOR fix — any self-signed-up user could otherwise
  read/write/delete another user's memory over the HTTP `/mcp` transport.
- **Evidence:** `brainrouter/src/transport/mcpServer.ts:307,318`

### 7. ⛔ Every persistence path for user text passes the redaction chokepoint (cap length first)

Text written into sensory or cognitive rows goes through
`redactSensitiveMemoryText()` (`memory/util/redaction.ts`). Paths that bypass the
capture pipeline (e.g. `upsertEngineeringMemory`, used by requirement/artifact/
annotation tools) must `.slice(0, 64_000)` **first**, then redact. Any new write
path into the cognitive graph wires in the same cap+redact pair.

- **Why:** unredacted secrets (Bearer/sk-/ghp_/PEM/conn-strings) would flow into
  recall, briefings, and LLM prompts; capping before redaction bounds CPU/storage
  amplification of one oversized capture.
- **Evidence:** `brainrouter/src/memory/engine/memoryOps.ts:164`, `brainrouter/src/memory/util/redaction.ts:23`

### 8. ⛔ All LLM-output JSON parsing goes through `memory/util/llm-json.ts`

Never `raw.match(/\[[\s\S]*\]/)` + `JSON.parse`. Route every LLM JSON parse
through `extractJsonValue(raw, { kind })` (or `extractJsonValueOrThrow`), which
strips fences, scans balanced spans, picks the **largest** parseable span, and
repairs trailing commas + bad escapes. It only guarantees valid JSON of the
requested *kind* — callers still validate the shape field-by-field (see
`parseExtractionResult`'s per-field clamping/coercion).

- **Why:** local/free models leak role tokens like `[user role]` before the
  payload; the greedy first-bracket regex matched that. Six call sites converted.
- **Evidence:** `brainrouter/src/memory/util/llm-json.ts:14`,
  `brainrouter/src/memory/pipeline/cognitive/cognitive-extractor.ts:268`,
  `brainrouter/src/memory/store/relevance-judge.ts:245`

---

## Capture & recall behavior

### 9. ⛔ `captureTurn` must never block the MCP reply on the LLM

Turn capture writes sensory rows + source docs synchronously, then dispatches
cognitive extraction in the **background**:
`void this.extractPendingSensory(...).catch(log).finally(clear-inflight)` guarded
by an `extractionInFlight` set keyed on `userId + sessionKey`, returning
`cognitiveExtractionStatus: "deferred"`. If an extraction for the session is
already running, still return `"deferred"` (the in-flight run + sweeper picks up
new rows). Inline blocking extraction exists only behind
`BRAINROUTER_INLINE_EXTRACTION=on` for debugging. Any new slow LLM work off a tool
call follows this pattern.

- **Why:** inline extraction blocked the reply for up to the LLM timeout (2–10
  min); disconnecting clients caused "Dropped MCP response" + a timeout cascade.
  The in-flight guard prevents concurrent double-extraction.
- **Evidence:** `brainrouter/src/memory/capture/entry.ts:60,77`

### 10. ⛔ Recall stage failures degrade, never fail the recall

Each stage must survive the next failing: vector-search errors are caught and
skipped; the reranker is gated on `isAvailable()` (circuit-breaker aware) and
falls back to RRF/MMR order in try/catch; the judge is gated on `isReady()` and on
failure keeps reranker output. Judge verdicts apply "recall-safely": default mode
`"reorder"` (approved first, nothing dropped); `"filter"` mode is floored by
`readJudgeMinKeep()` so it can never return 0 results.

- **Why:** a flaky cross-encoder or slow local judge must degrade recall quality,
  not break the agent's turn.
- **Evidence:** `brainrouter/src/memory/recall/pipeline.ts:108,374,447`

### 11. Apply candidate filters BEFORE RRF fusion

`RecallFilters` are applied to each of the three raw candidate streams (FTS,
vector, filepath) individually, before Reciprocal Rank Fusion — never filter the
merged/ranked list. When a filter needs data not on the FTS row
(`workspace_tag`/`project_tag`), batch-prefetch it once for all candidate ids
(`getWorkspaceTagsByRecordIds`) rather than widening the frozen FTS5 schema.

- **Why:** filtering after fusion biases scores toward globally-high but
  filter-irrelevant records; the FTS virtual-table schema is frozen.
- **Evidence:** `brainrouter/src/memory/recall/pipeline.ts:118,146`

### 12. ⛔ Artifact/annotation records are hard session-scoped; scoping filters are NULL-tolerant

- Records whose `metadata_json.kind` is in `SESSION_SCOPED_KINDS`
  (`'artifact'`, `'annotation'`) only surface when the record's `session_key`
  equals the recalling session's key — checked before/without optional filters. A
  new session-private kind must (a) stamp `metadata.kind` + `sessionKey` at
  capture and (b) be added to `SESSION_SCOPED_KINDS` in `recall/filters.ts`.
- `workspaceTag`/`projectTag` filtering is NULL-tolerant on both sides: a record
  with no tag surfaces everywhere (legacy/pre-migration rows), and a missing
  filter surfaces everything. Keep the `tag !== null && tag !== filter → drop`
  shape; do not tighten it to require a matching tag (federation rollout is
  gradual).
- **Evidence:** `brainrouter/src/memory/recall/filters.ts:46,71,92,105`

### 13. Config knobs: clamped `readX()` helpers, per-call overrides — never mutate `process.env`

Knobs are `BRAINROUTER_*`-prefixed env vars read at call time via small
`readX(env = process.env)` functions that parse, default, and clamp (recall limits
clamp to [1,200]). Callers needing deterministic variation (benchmarks, tests)
pass override params (`limitsOverride`, `selectionOverride`, `disableReranker`)
that layer over env-read defaults — never mutate `process.env` and restore in a
`finally` (it leaks across concurrent runs and flakes).

- **Evidence:** `brainrouter/src/memory/recall/config.ts:17`, `brainrouter/src/memory/recall/pipeline.ts:83,100`

### 14. No client-side timeout by default on outbound LLM/reranker/embedding calls

Outbound calls default to NO client-side timeout — slowness alone must never
abort. Timeouts are opt-in via per-service `*_TIMEOUT_MS` envs, normalized through
`parseRequestTimeoutMs`/`normalizeRequestTimeoutMs` (0/empty/negative/junk = no
timeout; positive floored to 1000ms) → `requestTimeoutSignal`. On a caught error,
use `isExternalTimeoutError(e)` (walks `error.cause`) to downgrade genuine
timeouts to a one-line `console.warn`, not a stack-trace `console.error`.

- **Why:** local LLMs / CPU cross-encoders legitimately take minutes; aborting
  mid-flight silently degraded recall and dumped stack traces that corrupted the
  CLI's Ink frame.
- **Evidence:** `brainrouter/src/memory/util/request-timeout.ts:1`, `brainrouter/src/memory/recall/pipeline.ts:477`

---

## MCP tool registry

### 15. Tool module anatomy: schema const + zod handler + `isError` result, one file per tool, one barrel per domain

Each MCP tool lives in `tools/<domain>/<tool_name>.ts` (file name = tool name)
exporting (1) `<camel>ToolSchema` — a plain JSON-Schema object literal `as const`
with name/description/inputSchema — and (2) `handle<Pascal>(args, options?)` which
zod-parses args, resolves the user via
`params.userId ?? options?.defaultUserId ?? "default"`, and returns MCP content
`{ content: [{ type: "text", text: JSON.stringify(result) }] }`. Handlers **catch**
errors and return `{ isError: true, content: [...] }` — they do not throw. Each
domain has an `index.ts` barrel. The zod schema and the JSON `inputSchema` are
maintained in parallel — update both.

- **Why:** throwing instead of returning `isError` breaks metrics success
  accounting and the MCP error shape.
- **Evidence:** `brainrouter/src/tools/recall/memory_recall.ts`, `brainrouter/src/tools/recall/index.ts`

### 16. Registering a tool requires BOTH the ListTools array and the CallTool switch in `mcpServer.ts`

`buildMcpServer` registers tools in two places that must stay in sync: the
`ListToolsRequestSchema` handler's tools array (push the schema const) and the
`CallToolRequestSchema` switch (add a `case` dispatching to the handler with
`{ defaultUserId }`). The dispatch is wrapped in an IIFE so every case flows
through one `recordToolCall(name, ok, durationMs)`; zod errors convert to
`McpError(ErrorCode.InvalidParams, …)`.

- **Why:** forgetting one half yields a tool that's advertised-but-unroutable or
  callable-but-invisible; bypassing the IIFE breaks per-tool observability.
- **Evidence:** `brainrouter/src/transport/mcpServer.ts:119,304,458`

### 17. Structured output: force a tool schema on extraction calls, keep the JSON chokepoint as fallback

Extraction calls pass a `tool` definition to `llmRunner.run` that fixes the
wrapper shape (e.g. `emit_focus_scenes` with intentionally *loose* item schemas)
so output parses across models — but the response is STILL parsed through
`extractJsonValue` because backends without tool support fall back to prompt-only
JSON. Treat `code === "LLM_NOT_CONFIGURED"` as an expected silent skip; a parse
failure returns `{ parseFailed: true }` so rows re-queue, while a genuinely empty
array is accepted as "nothing notable" so trivial turns aren't re-extracted
forever.

- **Evidence:** `brainrouter/src/memory/pipeline/cognitive/cognitive-extractor.ts:259,268,280`

### 18. Workspace memory tags survive the sensory-to-cognitive handoff

Semantic workspace tags are a bounded identifier list separate from the
single active-skill ranking field. Normalize them at the MCP and capture
boundaries, persist them on sensory rows, and recover them from those rows when
deferred or backlog extraction runs. Copy non-empty tags into cognitive
metadata, with the latest captured context replacing older tags; never rely
only on in-memory call arguments because extraction may resume after the
originating client or process is gone.

- **Evidence:** `brainrouter/src/memory/capture/memoryTags.ts`, `brainrouter/src/memory/capture/entry.ts`, `brainrouter/src/memory/capture/extraction.ts`, `brainrouter/src/memory/pipeline/cognitive/cognitive-extractor.ts`

---

## Cross-cutting notes for this package

- **ESM + NodeNext:** relative imports carry `.js`. `brainrouter/src` uses
  **double quotes** and **kebab-case** filenames (unlike core) — match the file.
- **Shared types** come from `@kinqs/brainrouter-types` (`IMemoryStore`,
  `CognitiveRecord`, `LLMRunner`), via `import type` when type-only.
- **Log prefix** is `[BrainRouter] …` on `console.error`/`warn`; operational logs
  go to **stderr** because stdout is the stdio MCP transport. Client-disconnect
  errors are classified by `transport-errors.ts` `isClientDisconnectError` and
  downgraded to warnings — dropped-reply noise is not a server fault.
- **Two brain test tiers:** `*.test.ts` (Vitest, DB-free, `vi.mock` the engine)
  vs `*.node-test.ts` (node:test on real Postgres, serial). See [`07`](07-testing.md).

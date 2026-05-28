# Brain Agents — Design Pass (0.4.0)

This document is the **0.4.0 design freeze** for the brain-side
agent registry, job queue, and the three MCP tools the CLI /
dashboard will call. Nothing here is implemented yet — Phase 1
(0.4.1) ships the runtime; this is the interface contract the
runtime must satisfy.

It lives next to the existing dev docs ([memory-engine.md](memory-engine.md),
[federation.md](federation.md)) so consumers can build against it
today (the type stubs in `packages/types/src/memory.ts` are
importable now) and the implementer has a single source of
truth tomorrow.

Roadmap context: [`FEATURE_OPENHUMAN_BRAINROUTER.md`](../FEATURE_OPENHUMAN_BRAINROUTER.md)
is the long-form rationale; [`FULL_TASKS.MD` §4.7](../FULL_TASKS.MD)
tracks each `BRAIN-DESIGN-T*` item; the Phase 1 implementation
plan lives in `§5.5` of the same file.

## What ships in 0.4.0

**Design artefacts only.** Specifically:

- `BrainAgent`, `BrainAgentStatus`, `BrainAgentModelClass` exported
  from `@kinqs/brainrouter-types` (BRAIN-DESIGN-T1).
- `MemoryJobRecord`, `MemoryJobStatus` exported (BRAIN-DESIGN-T2).
- `MemoryBlackboardItem`, `MemoryBlackboardKind`,
  `MemoryBlackboardStatus` exported (BRAIN-DESIGN-T4).
- This document (BRAIN-DESIGN-T3) — MCP tool schemas + the
  end-to-end lifecycle.

What does **not** ship in 0.4.0:

- No `brainrouter/src/memory/agents/` directory.
- No `memory_jobs` migration. No `memory_blackboard_items` migration.
- No `memory_agent_status` / `memory_agent_run` / `memory_job_retry`
  MCP handlers — the tools are doc-only until Phase 1.

The boundary keeps the 0.4.0 cycle tight while letting downstream
consumers (CLI `/brain` commands, dashboard widgets, the OpenHuman
borrows) build against the contract early.

## Why we need brain agents at all

The current pipeline already runs several specialist stages:
`cognitive_extractor`, `memory_deduper`, `contradiction_checker`,
`graph_extractor`, `focus_shift_judge`, `focus_distiller`,
`identity_distiller`, `relevance_judge`. They're scattered across
the `brainrouter/src/memory/` modules with their own ad-hoc
schedulers + retry semantics. Three observable failures of that
shape:

1. **Opaque state.** A user can't ask "is the extractor running?"
   The information lives in setInterval handles, log lines, and
   the operator's heads.
2. **No retries.** A transient LLM 429 silently drops a sensory
   row's extraction; nothing replays.
3. **No composition.** Stages chain via shared globals (the engine
   schedules them by reaching into other modules). Adding a sixth
   stage means another reach-across.

The `BrainAgent` interface formalises each stage as a registry row.
The `memory_jobs` table makes every run observable + retryable.
Together they get us "every brain-side action is a row, every row
has a status, every status is queryable."

## Brain agent registry (BRAIN-DESIGN-T1)

```ts
import type { BrainAgent } from '@kinqs/brainrouter-types';

const cognitiveExtractor: BrainAgent = {
  id: 'cognitive_extractor',
  description: 'Turns sensory turns into typed cognitive records.',
  inputSchema: { /* JSON Schema: SensoryRecord[] */ },
  outputSchema: { /* JSON Schema: CognitiveRecord[] */ },
  modelClass: 'extraction',
  maxAttempts: 3,
  timeoutMs: 90_000,
  batchSize: 8,
  idempotencyKey: (input) => `extract:${(input as any).sensoryIds.sort().join(',')}`,
  reads: ['sensory_stream'],
  writes: ['cognitive_records', 'cognitive_fts', 'embedding_meta'],
  emits: ['MemoryChunkStored'],
  dependsOn: [],
};
```

Field reference:

| Field | Meaning |
|---|---|
| `id` | Stable key; never changes after a deploy. |
| `description` | One-liner the dashboard surfaces. |
| `inputSchema` / `outputSchema` | JSON-Schema-shaped. Stored as `unknown` so the type doesn't pull a validator at this layer. |
| `modelClass` | One of `extraction` / `synthesis` / `judge` / `embedding` / `none`. Drives provider routing, tier ladder, cost grouping. |
| `maxAttempts` / `timeoutMs` / `batchSize` | Per-agent defaults. Per-job overrides allowed via `MemoryJobRecord.maxAttempts`. |
| `idempotencyKey(input)` | Pure function. Empty string → no in-flight dedup. Otherwise the scheduler refuses to enqueue a second job with the same key while the first is `pending` or `running`. |
| `reads` / `writes` | Table names this agent touches. The dashboard renders the dependency graph from these lists. |
| `emits` | Event names. The future event bus (Phase 4) routes by these. |
| `dependsOn` | Brain-agent IDs whose runs must complete before this one's runs become eligible. Empty = root. |

### Built-in registry inventory

Phase 1 will populate the registry with the eight existing pipeline
stages. The IDs are locked in now so dashboard / CLI consumers can
hard-code them:

| ID | modelClass | reads | writes | dependsOn |
|---|---|---|---|---|
| `cognitive_extractor` | extraction | `sensory_stream` | `cognitive_records`, `cognitive_fts`, `embedding_meta` | — |
| `memory_deduper` | judge | `cognitive_records` | `cognitive_records` (status update) | `cognitive_extractor` |
| `contradiction_checker` | judge | `cognitive_records` | `cognitive_records` (status), `contradictions` | `cognitive_extractor` |
| `graph_extractor` | extraction | `cognitive_records` | `graph_nodes`, `graph_edges` | `cognitive_extractor` |
| `focus_shift_judge` | judge | `cognitive_records` | `contextual_focus` (write activate) | `cognitive_extractor` |
| `focus_distiller` | synthesis | `cognitive_records`, `contextual_focus` | `contextual_focus` (summary) | `focus_shift_judge` |
| `identity_distiller` | synthesis | `cognitive_records` | `core_identity` | `cognitive_extractor` |
| `relevance_judge` | judge | `cognitive_records` (incoming candidates) | recall annotations (in-memory) | — |

Three more land as Phase 3+ (`source_chunker`, `tree_summarizer`,
`topic_curator`) and one as Phase 6 (`situation_reporter`).

## Job queue (BRAIN-DESIGN-T2)

```sql
CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- brain_agent_id
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed|cancelled
  priority INTEGER NOT NULL DEFAULT 50,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TEXT NOT NULL,            -- ISO; jobs not eligible until past this
  locked_at TEXT,                     -- ISO; non-NULL while running
  parent_job_id TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memory_jobs_eligible
  ON memory_jobs(status, priority DESC, run_after)
  WHERE status = 'pending';
CREATE INDEX idx_memory_jobs_running ON memory_jobs(locked_at) WHERE locked_at IS NOT NULL;
```

### Lifecycle

```
                           ┌────────────────────────────┐
                           │ pending                    │
                           │ (priority, runAfter)       │
                           └─────────────┬──────────────┘
                                         │ scheduler picks
                                         ▼
                           ┌────────────────────────────┐
                           │ running                    │
                           │ (lockedAt = now)           │
                           └─────────┬──────────────┬───┘
                                     │              │
                              success │              │ failure
                                     ▼              ▼
                           ┌──────────────┐   ┌────────────────────┐
                           │ done         │   │ failed             │
                           │              │   │ attempts ↑         │
                           └──────────────┘   └─────────┬──────────┘
                                                       │ attempts < maxAttempts
                                                       │ + exponential backoff
                                                       ▼
                                              ┌────────────────────┐
                                              │ pending (re-armed) │
                                              └────────────────────┘
```

`cancelled` is reached only via explicit operator intervention or
the sweeper noticing a `running` job whose `lockedAt` is older than
`timeoutMs × 2`.

### Backoff

Phase 1 uses `2^attempts × 30 s + jitter` on failure, capped at 5 min.
The schedule lives in code; the `runAfter` column is the authoritative
"do not run before" signal.

## MCP tool schemas (BRAIN-DESIGN-T3)

Three read-side tools. The CLI / dashboard observe brain state via
these; they do **not** write to the registry directly.

### `memory_agent_status`

```jsonc
{
  "name": "memory_agent_status",
  "description": "List brain agents with their last-run status, success rate, and pending-job counts. Read-only; safe for dashboards to poll on a 10 s interval.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "userId": { "type": "string" },
      "agentId": { "type": "string", "description": "Optional — when set, return only this agent." }
    }
  }
}
```

Returns:

```ts
{ agents: BrainAgentStatus[] }
```

### `memory_agent_run`

```jsonc
{
  "name": "memory_agent_run",
  "description": "Enqueue a brain-agent run with the provided input. Returns the job id immediately; status is observed via memory_agent_status. Idempotent per the agent's idempotencyKey — re-enqueueing while a job is pending/running returns the existing jobId.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "userId": { "type": "string" },
      "agentId": { "type": "string" },
      "input": { "type": "object" },
      "priority": { "type": "number", "description": "Override default 50; higher runs sooner." }
    },
    "required": ["agentId", "input"]
  }
}
```

Returns:

```ts
{ jobId: string; status: MemoryJobStatus }
```

### `memory_job_retry`

```jsonc
{
  "name": "memory_job_retry",
  "description": "Re-arm a failed or cancelled job. Resets `attempts` to 0 and `status` to `pending` with `runAfter` = now. No-op for jobs in `pending`, `running`, or `done`.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "userId": { "type": "string" },
      "jobId": { "type": "string" }
    },
    "required": ["jobId"]
  }
}
```

Returns:

```ts
{ status: MemoryJobStatus }
```

All three tools follow the existing `defaultUserId` fallback pattern
the other memory tools use; `userId` is optional in the schema and
resolved from the request context when absent.

## Blackboard (BRAIN-DESIGN-T4)

The blackboard is the "candidate memory" layer between raw
extraction and the cognitive store. It lets multiple agents
collaborate on a candidate record before it lands. Phase 5 wires the
commit pipeline.

```sql
CREATE TABLE IF NOT EXISTS memory_blackboard_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- candidate_record | claim | critique | ...
  source_job_id TEXT NOT NULL,        -- FK to memory_jobs.id
  parent_record_id TEXT,              -- existing cognitive record this refines/merges into
  payload_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.5,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|merged|committed|rejected|superseded
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (source_job_id) REFERENCES memory_jobs(id) ON DELETE CASCADE
);
CREATE INDEX idx_blackboard_active ON memory_blackboard_items(status, created_at) WHERE status = 'pending';
```

### Commit pipeline (Phase 5)

The blackboard's value is the **chain**, not the table:

```
sensory turn
  → cognitive_extractor job
    → blackboard item: kind=candidate_record, status=pending
      → memory_deduper job  → kind=critique (or status=merged)
      → contradiction_checker job → kind=critique (status=pending → status=committed|rejected)
      → evidence agent (Phase 4+) → kind=needs_evidence → kind=verification_result
    → committer (Phase 5) reads status=committed items → inserts into cognitive_records
```

Three properties this gets us:

- **Reviewable.** An operator (or the dashboard) can query
  `memory_blackboard_items WHERE status = 'rejected'` to see what
  the brain refused to store and why.
- **Auditable.** Each cognitive_records row eventually carries a
  `source_blackboard_id` back-reference so the lineage is queryable.
- **Pluggable.** Adding a new "critique" agent in Phase 6 doesn't
  touch the committer — it just writes more `kind=critique` rows.

The full lifecycle write-up lives in
[`FEATURE_OPENHUMAN_BRAINROUTER.md`](../FEATURE_OPENHUMAN_BRAINROUTER.md)
under "Phase 5 — Blackboard and Memory Commit Pipeline".

## Where the implementation will live (Phase 1, 0.4.1)

For implementer reference — these paths don't exist yet:

```
brainrouter/src/memory/
  agents/
    registry.ts        # listBrainAgents(), findBrainAgentById()
    cognitive_extractor.ts
    memory_deduper.ts
    contradiction_checker.ts
    graph_extractor.ts
    focus_shift_judge.ts
    focus_distiller.ts
    identity_distiller.ts
    relevance_judge.ts
  scheduler/
    jobs.ts            # enqueue / lock / heartbeat / retry
    runner.ts          # main loop; picks eligible jobs, dispatches
    backoff.ts         # 2^attempts × 30s + jitter, cap 5min
  blackboard/
    items.ts           # CRUD + committer
brainrouter/src/tools/
  memory_agent_status.ts
  memory_agent_run.ts
  memory_job_retry.ts
brainrouter/src/api/routes/
  brain_agents.ts      # GET /api/brain/agents + /api/brain/jobs (dashboard)
```

The CLI's `/brain agents` / `/brain jobs` / `/brain retry <id>` /
`/brain why <memoryId>` commands (CLI Multi-Agent Phase 6) are also
gated on this surface — see
[`FEATURE_CLI_MULTI_AGENTS_LOGIC_ENHANCEMENT_TASKS.md`](../FEATURE_CLI_MULTI_AGENTS_LOGIC_ENHANCEMENT_TASKS.md)
§19.

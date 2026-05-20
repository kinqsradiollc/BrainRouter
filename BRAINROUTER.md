# BrainRouter Implementation Reference

This document describes the current code in this repository. It intentionally avoids older roadmap language that is not present in `mcp/src`.

## Runtime Architecture

BrainRouter is a TypeScript monorepo with four active runtime areas:

- `mcp/`: MCP server, Express REST API, memory engine, SQLite store, setup scripts, and tests.
- `web/`: Next.js dashboard.
- `packages/types/`: shared API, memory, and store types.
- `packages/sdk/` and `packages/hooks/`: typed REST client and React hooks used by the dashboard.

The MCP package has one entrypoint, [mcp/src/index.ts](./mcp/src/index.ts). It creates a registry, scans skill hints, constructs an MCP server, and then starts either stdio or HTTP transport.

## Transport Modes

### stdio

stdio is the default mode. The MCP client spawns `node dist/index.js` and communicates through stdin/stdout. stdout is reserved for MCP protocol messages; logs are redirected to stderr.

Authentication is mandatory. Provide an API key with:

- `BRAINROUTER_API_KEY` in the MCP client environment, or
- `--apiKey <key>` on the command line.

### Streamable HTTP

HTTP mode starts Express and Streamable HTTP:

```bash
cd mcp
npm run dev:http
```

or after build:

```bash
cd mcp
npm run start:http
```

The default port is `3747`. You can override it with `--port`.

Endpoints:

- `GET /health`
- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`
- REST routes under `/api`

`/mcp` requires `Authorization: Bearer <api-key>`. A first `POST /mcp` without `mcp-session-id` initializes a Streamable HTTP session. Later requests use the returned `mcp-session-id`.

## Root and Registry Resolution

[mcp/src/resolver.ts](./mcp/src/resolver.ts) resolves the global BrainRouter root and the local workspace root.

Local root priority:

1. `--root <path>`
2. `BRAINROUTER_LOCAL_ROOT`
3. Auto-detection by walking from the current working directory for `brainrouter.config.json`
4. The BrainRouter repository itself

The registry merges global and local skills, personas, references, and template docs. This is why MCP clients should pass the workspace they want BrainRouter to reason about.

## Authentication Model

BrainRouter has two auth paths:

- API key auth for MCP clients and REST integrations.
- JWT auth for the dashboard.

The first empty database boot seeds an admin user. The admin email defaults to `admin` or `BRAINROUTER_ADMIN_EMAIL`; the password is set only if `BRAINROUTER_ADMIN_PASSWORD` exists. The generated API key is printed once.

Use the setup script to create or reset an admin:

```bash
cd mcp
npm run setup:admin -- --reset --userId admin --email admin@example.com --password change-me
```

The script honors `BRAINROUTER_MEMORY_DB`.

REST middleware:

- `requireAuth`: API key only.
- `requireJwt`: dashboard JWT only.
- `requireAnyAuth`: JWT or API key.
- `requireAdmin`: requires an authenticated admin user.

## MCP Tool Surface

The server advertises the same tool list for stdio and HTTP. `create_skill` and `update_skill` throw unless the authenticated user is an admin.

### Registry Tools

| Tool | Purpose |
| --- | --- |
| `list_skills` | List global, local, or merged skills. |
| `get_skill` | Fetch a skill section or a file inside a skill directory. |
| `search_skills` | Fuzzy search across skills. |
| `get_persona` | Fetch a persona definition. |
| `get_reference` | Fetch a reference document. |
| `list_template_docs` | List project template docs. |
| `get_template_doc` | Read a template doc or heading section. |
| `create_skill` | Scaffold a skill. Admin only. |
| `update_skill` | Update a skill section. Admin only. |

### Long-Term Memory Tools

| Tool | Purpose |
| --- | --- |
| `memory_resolve_session` | Resolve a stable UUID session key from workspace/conversation hints. |
| `memory_capture_turn` | Store new L0 messages and trigger extraction when enough unextracted messages exist. |
| `memory_recall` | Retrieve relevant memories, persona context, scene context, and tool guidance. |
| `memory_search` | Run recall-like search, with optional point-in-time `asOf` search. |
| `memory_graph_query` | Query graph neighbors for an entity. |
| `memory_contradictions` | List unresolved contradictions. |
| `memory_mark_cited` | Mark recalled memories as cited or ignored for the ACE feedback loop. |
| `memory_register_skill_hints` | Store extraction hints for a skill. |
| `memory_explain_recall` | Re-run recall with scoring/explanation metadata and no recall audit write. |

### Governance Tools

| Tool | Purpose |
| --- | --- |
| `memory_get` | Fetch one memory with evidence. |
| `memory_update` | Update memory content, confidence, status, or verification metadata. |
| `memory_evidence_add` | Attach evidence to a memory. |
| `memory_evidence_get` | Fetch evidence for a memory. |
| `memory_export` | Export memories, evidence, and audit operations. |
| `memory_import` | Import a versioned memory export envelope. |
| `memory_governance_delete` | Hard delete a memory and write audit evidence. |
| `memory_audit` | List memory audit operations. |
| `memory_diagnostics` | Return runtime/database diagnostics and recent degradation logs. |

### Engineering Workflow Tools

| Tool | Purpose |
| --- | --- |
| `memory_debug_trace_save` | Save symptom, repro, cause, fix, verification, files, and commands. |
| `memory_debug_trace_search` | Search saved debug traces. |
| `memory_failed_attempts` | Search prior failed attempts. |
| `memory_file_history` | Return memories associated with a file path. |
| `memory_task_state` | Read current task or handover memories. |
| `memory_task_update` | Write task progress, blockers, and next actions. |
| `memory_handover` | Generate a compact continuation note. |
| `memory_verify` | Update verification status and confidence. |

### Hook and Working-Memory Tools

| Tool | Purpose |
| --- | --- |
| `memory_hook_register` | Register or ingest a host hook event. |
| `memory_hook_status` | List registered host hooks. |
| `memory_working_context` | Read session working-memory state and compact context. |
| `memory_working_offload` | Save large payloads under `.brainrouter/work/...` and return a node reference. |
| `memory_working_reset` | Clear working-memory files for a session. |

## Memory Storage

The store is [mcp/src/memory/store/sqlite.ts](./mcp/src/memory/store/sqlite.ts). The default database path is:

```text
~/.brainrouter/memory.db
```

Override it with:

```env
BRAINROUTER_MEMORY_DB=/absolute/path/to/memory.db
```

The store initializes SQLite tables, FTS indexes, vector tables when possible, users, L0 records, L1 records, contradictions, graph nodes/edges, scene/persona data, evidence, operations, skill hints, activations, scheduler state, hook registrations, and extraction health state.

## Capture Pipeline

The capture path is [mcp/src/memory/capture.ts](./mcp/src/memory/capture.ts).

1. `memory_capture_turn` receives `sessionKey`, optional `sessionId`, messages, optional `activeSkill`, and optional `skillHints`.
2. The effective user is the explicit `userId`, the authenticated default user, or `default`.
3. Sensitive values are redacted before L0 writes.
4. If `activeSkill` is present, its activation is spiked.
5. Pending L0 messages are extracted when the unextracted count reaches the current threshold. The engine currently constructs `MemoryCapturePipeline` with `extractEveryNTurns = 1`.
6. L1 extraction calls an OpenAI-compatible chat-completions endpoint.
7. L1 deduplication runs before storage.
8. Stored L1 records optionally receive background embeddings.
9. Contradiction detection and graph extraction run in background tasks.
10. Scheduler counters may trigger L2 scene distillation and L3 persona distillation.

Extraction failures are recorded so the sweeper can retry eligible unextracted backlog later.

## Recall Pipeline

The recall path is [mcp/src/memory/recall.ts](./mcp/src/memory/recall.ts).

Recall combines:

- FTS5 keyword search.
- File-path specific matching.
- Optional vector search when embedding config is available.
- Reciprocal Rank Fusion.
- Priority decay by memory type.
- ACE citation boosts.
- Active-skill boost.
- Intent/type affinity.
- Optional reranking.
- L2 scene navigation.
- L3 persona injection.
- Graph expansion from matched entities.
- Optional skill pre-warming block when `BRAINROUTER_PREWARM_ENABLED=true`.

When no records match, recall returns either `hybrid-empty` or `keyword-empty`.

## Memory Layers in the Current Code

| Layer | Current implementation |
| --- | --- |
| L0 | Redacted raw messages stored per user/session. |
| L1 | Extracted engineering memories with types, confidence, status, metadata, source kind, repo paths, file paths, commands, and citation fields. |
| L1.5 | Contradiction records generated from L1 comparisons and resolved/dismissed by tool or REST API. |
| Graph | Entity/relation extraction from L1 records plus neighbor queries and recall expansion. |
| L2 | Scene records distilled from L1 batches or direction shifts. |
| L3 | Persona markdown distilled from long-term records and cached in process. |
| Working memory | Filesystem-backed short-term refs, step logs, Mermaid canvas, and compact state under `.brainrouter/work/<user>/<session>/`. |

## Skill Activation and Pre-Warming

Skill activation is implemented in [mcp/src/memory/pipeline/skill-prewarm.ts](./mcp/src/memory/pipeline/skill-prewarm.ts).

Defaults:

- Half-life: `10` minutes.
- Minimum per-turn decay: `0.05`.
- Pre-warm threshold: `0.3`.
- Spike amount: `1.0`.
- Max potential: `4.0`.

`memory_capture_turn` and `memory_recall` spike `activeSkill` when one is supplied. The REST dashboard can read decayed skill activations through `GET /api/skills/activations`.

Automatic skill-hint injection into recall is opt-in with `BRAINROUTER_PREWARM_ENABLED=true`.

## REST API Map

Most routes use `requireAnyAuth`, so they accept either a dashboard JWT or an API key as `Authorization: Bearer ...`. `/api/users` requires admin JWT auth.

| Route | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Server status, HTTP transport, and resolved root. |
| `/api/auth/signin` | POST | Email/password sign in; returns JWT and API key. |
| `/api/auth/signup` | POST | Open signup for a non-admin user. |
| `/api/auth/me` | GET | Current user profile and MCP path. |
| `/api/auth/rotate-key` | POST | Rotate current user's API key. |
| `/api/users` | GET | List users. Admin only. |
| `/api/users` | POST | Create user. Admin only. |
| `/api/users/:id/status` | PUT | Enable/disable user. Admin only. |
| `/api/users/:id/reset-key` | POST | Reset a user's API key. Admin only. |
| `/api/users/:id` | DELETE | Delete user. Admin only. |
| `/api/memories` | GET | Paginated L1 memory list with type/scene/skill/archived filters. |
| `/api/memories/:recordId` | GET | One memory plus evidence. |
| `/api/memories/:recordId` | PATCH | Update content/status/confidence/verification metadata. |
| `/api/memories/:recordId/evidence` | POST | Attach evidence. |
| `/api/memories/:recordId/evidence` | GET | Evidence for one memory. |
| `/api/memories/:id` | DELETE | Archive, or hard delete when a reason is supplied. |
| `/api/export` | GET | Export memory envelope. |
| `/api/import` | POST | Import memory envelope. |
| `/api/audit` | GET | Paginated audit operations. |
| `/api/operations` | GET | Paginated timeline with filters. |
| `/api/governance/diagnostics` | GET | Diagnostics bundle. |
| `/api/recall/explain` | POST | Recall inspector. |
| `/api/evidence` | GET | Paginated evidence list. |
| `/api/evidence/:recordId` | GET | Evidence by record. |
| `/api/scenes` | GET | Paginated top scenes. |
| `/api/persona` | GET | Current persona. |
| `/api/contradictions` | GET | Pending contradictions. |
| `/api/contradictions/:id/resolve` | POST | Resolve or dismiss contradiction. |
| `/api/graph` | GET | Graph neighbors for `entity`. |
| `/api/stats` | GET | Memory stats. |
| `/api/hooks/register` | POST | Register host hooks and optionally ingest an event. |
| `/api/hooks/status` | GET | List hook registrations. |
| `/api/working/context` | GET | Working-memory context. |
| `/api/working/offload` | POST | Offload a large payload. |
| `/api/working/reset` | POST | Reset working memory for a session. |
| `/api/working/sessions` | GET | List active working-memory sessions. |
| `/api/skills/activations` | GET | Decayed skill activations. |

## Environment Variables

The current code reads these environment variables:

| Variable | Purpose |
| --- | --- |
| `BRAINROUTER_API_KEY` | API key for stdio MCP authentication. |
| `BRAINROUTER_USER_ID` | Legacy stdio default fallback before auth mapping; normally not needed. |
| `BRAINROUTER_LOCAL_ROOT` | Local workspace root when `--root` is omitted. |
| `BRAINROUTER_MEMORY_DB` | SQLite database path. |
| `BRAINROUTER_ADMIN_EMAIL` | Seed/setup admin email. |
| `BRAINROUTER_ADMIN_PASSWORD` | Seed/setup admin password. |
| `BRAINROUTER_DEFAULT_ADMIN_USER_ID` | Seeded admin user id. |
| `BRAINROUTER_JWT_SECRET` | JWT signing secret. |
| `BRAINROUTER_JWT_EXPIRES_SECS` | JWT expiry, default `86400`. |
| `BRAINROUTER_LLM_API_KEY` | Required for L1/L2/L3 extraction. |
| `BRAINROUTER_LLM_ENDPOINT` | Chat-completions endpoint. |
| `BRAINROUTER_LLM_MODEL` | Default chat model. |
| `BRAINROUTER_EXTRACTION_MODEL` | Override model for extraction/contradiction/graph tasks. |
| `BRAINROUTER_SYNTHESIS_MODEL` | Override model for L2/L3 synthesis. |
| `BRAINROUTER_EMBEDDING_API_KEY` | Optional embedding API key; falls back to LLM key. |
| `BRAINROUTER_EMBEDDING_ENDPOINT` | Embeddings endpoint. |
| `BRAINROUTER_EMBEDDING_MODEL` | Embeddings model. |
| `BRAINROUTER_EMBEDDING_DIMENSIONS` | Vector dimension; changing it may rebuild vector state. |
| `BRAINROUTER_RERANKER_API_KEY` | Optional reranker key. |
| `BRAINROUTER_RERANKER_ENDPOINT` | Reranker endpoint. |
| `BRAINROUTER_RERANKER_MODEL` | Reranker model. |
| `BRAINROUTER_RERANKER_TOP_N` | Number of reranked documents to keep. |
| `BRAINROUTER_PERSONA_CACHE_TTL_MS` | In-process persona cache TTL. |
| `BRAINROUTER_L2_TRIGGER_N` | Count threshold for L2 scene distillation. |
| `BRAINROUTER_L3_TRIGGER_N` | Count threshold for L3 persona distillation. |
| `BRAINROUTER_L2_MAX_SCENES` | Max L2 scenes before consolidation behavior. |
| `BRAINROUTER_GRAPH_ENABLED` | Set `false` to disable graph extraction. |
| `BRAINROUTER_GRAPH_TIMEOUT_MS` | Graph extraction timeout. |
| `BRAINROUTER_CONTRADICTION_TIMEOUT_MS` | Contradiction detection timeout. |
| `BRAINROUTER_ACE_ARCHIVE_THRESHOLD` | Auto-archive ignored memories; `0` disables. |
| `BRAINROUTER_PREWARM_ENABLED` | Enables pre-warm block injection in recall. |
| `BRAINROUTER_PREWARM_MIN_HITS` | Pre-warm hit threshold. |
| `BRAINROUTER_PREWARM_WINDOW` | L1 scan window for pre-warm detection. |
| `BRAINROUTER_SKILL_HALF_LIFE_MINUTES` | Skill activation half-life. |
| `BRAINROUTER_SKILL_MIN_TURN_DECAY` | Minimum turn decay. |
| `BRAINROUTER_SKILL_PREWARM_THRESHOLD` | Skill pre-warm threshold. |
| `BRAINROUTER_SKILL_SPIKE_AMOUNT` | Skill potential spike amount. |
| `BRAINROUTER_SKILL_MAX_POTENTIAL` | Skill potential cap. |
| `BRAINROUTER_DISABLE_EXTRACTION_SWEEPER` | Disable backlog sweeper when `true`. |
| `BRAINROUTER_EXTRACTION_SWEEP_INTERVAL_MS` | Sweeper interval. |
| `BRAINROUTER_EXTRACTION_SWEEP_MIN_AGE_MS` | Minimum backlog record age before retry. |
| `BRAINROUTER_EXTRACTION_MAX_FAILURES` | Failure cap for backlog retry. |
| `NEXT_PUBLIC_API_URL` | Dashboard API base URL. |

## Verification Commands

```bash
npm run build
npm test
```

For an isolated admin/key smoke test:

```bash
cd mcp
BRAINROUTER_MEMORY_DB=/private/tmp/brainrouter-smoke.db npm run setup:admin -- --reset --userId admin
```

Then use the printed API key for stdio or HTTP MCP checks.

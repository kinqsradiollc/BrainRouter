# Memory System Comparison: BrainRouter vs agentmemory vs TencentDB-Agent-Memory

Generated: 2026-05-19

## Scope

This is a static repo inspection of:

- BrainRouter current workspace: `/Users/anhdang/Documents/Github/BrainRouter`
- Alternative reference: `/Users/anhdang/Documents/Github/agentmemory`
- Alternative reference: `/Users/anhdang/Documents/Github/TencentDB-Agent-Memory`
- Copied alternatives already present under `alternative/`

I did not run their benchmark suites or live servers. The comparison is based on README/package/source/test surfaces and BrainRouter's current memory implementation in `mcp/src/memory`, `mcp/src/tools`, `mcp/src/api`, `dashboard`, and `packages`.

## Executive Summary

BrainRouter already has the right core long-term memory shape: L0 capture, L1 extraction, L1.5 contradiction detection, L2 scenes, L3 persona, multi-tenant SQLite, FTS5, sqlite-vec, RRF, optional reranker, graph extraction, skill hints, ACE citation feedback, HTTP API, dashboard pages, SDK/hooks, and point-in-time search.

The largest gaps are not the basic memory pyramid. The gaps are operational maturity, automatic host integration, observability, diagnostics, export/import, governance, benchmark discipline, and short-term context offload.

The two alternatives have different strengths:

- `agentmemory` is strongest as a broad memory product: many MCP tools, hooks for multiple agents, REST API, viewer, replay, governance/audit/export/import/snapshot/team/mesh/health, lots of tests, and benchmark artifacts.
- `TencentDB-Agent-Memory` is strongest on layered memory plus symbolic short-term compression: Mermaid task canvases, traceable offloaded logs, human-readable L2/L3 artifacts, OpenClaw/Hermes adapters, operational CLI, diagnostics export, retention, and a Tencent Cloud vector backend path.

BrainRouter should not copy either wholesale. It should preserve its MCP-native skill-router identity and upgrade the missing capabilities in phases.

## Current BrainRouter Baseline

Observed BrainRouter memory capabilities:

- MCP tools:
  - `memory_resolve_session`
  - `memory_capture_turn`
  - `memory_recall`
  - `memory_search`
  - `memory_graph_query`
  - `memory_contradictions`
  - `memory_mark_cited`
  - `memory_register_skill_hints`
- Long-term hierarchy:
  - L0 raw conversation records in SQLite
  - L1 extracted memories
  - L1.5 contradictions
  - L2 scene summaries
  - L3 persona summaries
- Memory types:
  - `persona`
  - `episodic`
  - `instruction`
  - `skill_context`
- Retrieval:
  - FTS5 keyword search
  - sqlite-vec vector search
  - RRF merge
  - half-life decay by memory type
  - skill tag boost
  - optional external reranker
  - graph recall expansion
  - optional skill prewarming
- Multi-tenant model:
  - `user_id` scoped tables
  - API keys and JWT auth for HTTP/dashboard mode
- Feedback loop:
  - `memory_mark_cited`
  - citation count boost
  - never-cited count
  - optional auto-archive threshold
- Admin/product surface:
  - Express API routes for users, memories, scenes, persona, contradictions, graph, stats, auth
  - Next.js dashboard pages
  - SDK, hooks, and shared types packages
- Benchmark scripts:
  - LongMemEval, quality, scale, load, real embeddings, e2e, overnight scripts are present in `mcp/package.json`

## What agentmemory Has That BrainRouter Does Not Yet Have

### 1. Broad automatic host integration

`agentmemory` has explicit connector code and documentation for Claude Code, Codex, Cursor, Gemini CLI, Hermes, OpenClaw, OpenHuman, pi, and generic MCP/REST users.

BrainRouter currently supports MCP transport and setup generation, but it does not yet have the same host-specific lifecycle hook coverage.

Gap:

- No BrainRouter equivalent of a mature host connector matrix.
- No automatic per-host hook install flow for prompt submit, pre-tool, post-tool, pre-compact, stop, session start/end, subagent events, tool-failure events, etc.
- Current capture depends on the agent calling `memory_capture_turn`; the alternatives can capture more passively through hooks.

Suggested upgrade:

- Build a `packages/hooks-hosts` or `mcp/src/integrations` layer with adapters for Codex, Claude Code, OpenClaw, Hermes, and generic MCP.
- Start with Codex and Claude Code because they map closest to the user's workflow.
- Make hook support explicit in docs: supported events, what gets captured, privacy filtering, and failure behavior.

### 2. Large MCP tool surface and memory operations

`agentmemory` documents 51 tools. Important missing categories in BrainRouter:

- `memory_export`
- `memory_import`
- `memory_audit`
- `memory_governance_delete`
- `memory_snapshot_create`
- `memory_timeline`
- `memory_sessions`
- `memory_file_history`
- `memory_profile`
- `memory_patterns`
- `memory_relations`
- `memory_verify`
- action/work queue tools:
  - `memory_action_create`
  - `memory_action_update`
  - `memory_frontier`
  - `memory_next`
  - `memory_lease`
- team/mesh/signal tools:
  - `memory_team_share`
  - `memory_team_feed`
  - `memory_mesh_sync`
  - `memory_signal_send`
  - `memory_signal_read`
- health/self-repair tools:
  - `memory_diagnose`
  - `memory_heal`
- event watchers:
  - `memory_sentinel_create`
  - `memory_sentinel_trigger`
- temporary planning memory:
  - `memory_sketch_create`
  - `memory_sketch_promote`

BrainRouter does have graph query, contradiction handling, skill hints, recall, search, and citation feedback, but not the operational and collaborative tool families above.

Suggested upgrade:

- Do not add 51 tools at once.
- Add the missing categories in this order:
  1. Export/import, audit, governance delete.
  2. Timeline/sessions/file-history/profile.
  3. Diagnostics/health/repair.
  4. Action/frontier/lease only if BrainRouter wants to coordinate multiple agents.
  5. Team/mesh/signal later, after data isolation and governance are stronger.

### 3. Real-time viewer and replay

`agentmemory` has a viewer on port `3113` with live observation stream, session explorer, memory browser, graph visualization, health dashboard, and session replay.

BrainRouter has a dashboard, but the current pages appear focused on admin CRUD and memory browsing. I did not find a live event stream, replay scrubber, or per-observation timeline.

Gap:

- No replay-first debugging workflow.
- No live stream of capture/extraction/recall operations.
- No visual graph explorer equivalent.

Suggested upgrade:

- Add an observability/event table for memory operations:
  - capture started/succeeded/failed
  - L1 extraction started/succeeded/failed
  - L2/L3 distillation events
  - recall query, strategy, latency, hit count
  - graph expansion count
  - reranker used/skipped/error
- Expose `/api/events` and a dashboard "Timeline" or "Replay" page.
- Make recall failures debuggable without reading server logs.

### 4. Governance, privacy, and audit maturity

`agentmemory` has explicit audit, governance delete, export/import, retention, auto-forget, privacy filtering, replay-sensitive tests, and security/viewer tests.

BrainRouter has:

- JWT/API-key auth
- user isolation
- archive-on-never-cited support
- API routes

But I did not find an equivalent full governance layer.

Gap:

- No first-class audit table for memory create/update/delete/recall/export/admin actions.
- No formal delete-with-audit tool.
- No export/import round-trip.
- No privacy filter that strips API keys/secrets before L0 storage.
- No retention policy per memory type or per tenant.
- No diagnostic export with redaction.

Suggested upgrade:

- Add `memory_audit_log` table and write to it from:
  - L0 capture
  - L1 upsert/archive
  - contradiction resolution
  - user/admin operations
  - export/import/delete
- Add a privacy filter before L0 writes:
  - API keys
  - bearer tokens
  - private key blocks
  - `.env` style secrets
  - user-marked private tags
- Add `memory_export`, `memory_import`, and `memory_governance_delete` before adding more retrieval tricks.

### 5. Benchmark and quality evidence

`agentmemory` has benchmark docs and scripts for LongMemEval, quality, scale, real embeddings, load tests, and competitor comparison. It also has many focused tests around memory behavior.

BrainRouter has benchmark scripts in `mcp/package.json`, and there are benchmark result folders, but it does not yet look like the same level of published methodology/reporting.

Gap:

- Need a current BrainRouter benchmark README explaining datasets, modes, metrics, and reproducibility.
- Need token-savings measurement as a first-class output, not only recall quality.
- Need p50/p95/p99 recall and capture latency.
- Need end-to-end full-flow scoring: capture -> L1 -> L2 -> L3 -> recall -> citation feedback.

Suggested upgrade:

- Add `mcp/benchmark/README.md` with exact commands and expected artifacts.
- Make each run write a JSON result plus markdown summary.
- Track:
  - retrieval R@5/R@10/MRR
  - prompt tokens injected
  - tokens saved vs naive history injection
  - capture latency
  - recall latency
  - extraction cost
  - memory drift/contradiction rate

### 6. Advanced memory product features

`agentmemory` has code/tests for concepts BrainRouter may want later:

- context slots and pinned context
- lessons/preferences/profile
- routines
- file watcher / filesystem indexing
- session snapshots
- team sharing
- P2P mesh sync
- leases for multi-agent work
- sentinels/watchers
- multimodal and vision search
- Obsidian export
- schema fingerprinting
- provider fallback/circuit breaker

Suggested upgrade:

- Treat these as research candidates, not immediate implementation targets.
- The highest-leverage subset for BrainRouter is:
  - file-history memories
  - pinned context slots
  - snapshots
  - diagnostics
  - provider fallback/circuit breaker

## What TencentDB-Agent-Memory Has That BrainRouter Does Not Yet Have

### 1. Symbolic short-term context offload

TencentDB's key feature is not just L0-L3 long-term memory. It also offloads verbose tool logs into files and leaves a compact Mermaid task canvas in context.

It uses:

- raw refs/files for heavy payloads
- JSONL or structured summaries for step-level state
- Mermaid task canvas with `node_id`
- drill-down from canvas -> node -> raw result reference

BrainRouter currently has long-term memory and graph recall, but I did not find an equivalent short-term offload pipeline for massive tool outputs inside one long task.

Gap:

- No Mermaid canvas or equivalent compact symbolic state.
- No automatic offload of verbose tool results to refs.
- No `node_id` / `result_ref` drill-down path.
- No token-pressure-triggered compression path for the active session.

Suggested upgrade:

- Add a separate "working context offload" subsystem, not mixed into L1 long-term memory.
- Proposed layers:
  - W0: raw tool payload refs in `.brainrouter/work/<session>/refs/*.md`
  - W1: step JSONL summaries
  - W2: Mermaid task canvas
  - W3: current state block injected into context
- Trigger on token pressure:
  - mild offload when context is >50 percent
  - aggressive offload when context is >85 percent
- Keep all references reversible with `node_id` and `result_ref`.

### 2. Human-readable memory artifacts

TencentDB stores upper layers as readable files:

- `scene_blocks/*.md`
- `persona.md`
- Mermaid canvases
- `.metadata/scene_index.json`
- `.backup/`

BrainRouter stores L2 and L3 in SQLite tables. This is good for API/dashboard work but less white-box for local debugging.

Gap:

- No filesystem mirror of L2/L3 for inspection and git diffing.
- No deterministic local artifact layout for troubleshooting.
- No rolling backup folder for persona/scenes.

Suggested upgrade:

- Keep SQLite as source of truth.
- Add optional mirror export:
  - `.brainrouter/memory/<user>/persona.md`
  - `.brainrouter/memory/<user>/scene_blocks/*.md`
  - `.brainrouter/memory/<user>/metadata/scene_index.json`
- Mirror on L2/L3 distillation and include source L1 IDs.
- Add a dashboard button/API route to regenerate mirrors.

### 3. Operational CLI for gateway and backend switching

TencentDB has `memory-tencentdb-ctl.sh` for:

- standalone vs Hermes mode
- start/stop/restart/status/logs
- writing config files with restricted permissions
- configuring LLM, embedding, and Tencent Cloud VDB credentials
- switching from TencentDB VDB back to SQLite
- showing redacted config

BrainRouter has npm scripts and setup scripts, but not a dedicated operations CLI for memory runtime management.

Gap:

- No unified `brainrouter memory status/config/doctor/export/backup` command.
- No redacted config display.
- No backend switching CLI.
- No migration helper if/when a remote vector DB is added.

Suggested upgrade:

- Add a CLI namespace:
  - `brainrouter memory status`
  - `brainrouter memory doctor`
  - `brainrouter memory config show`
  - `brainrouter memory config set-llm`
  - `brainrouter memory config set-embedding`
  - `brainrouter memory export-diagnostic`
  - `brainrouter memory backup`
  - `brainrouter memory migrate`

### 4. Backend abstraction beyond local SQLite

TencentDB includes local SQLite and a Tencent Cloud VectorDB path (`tcvdb-client`, `tcvdb`, migration/export scripts).

BrainRouter currently has `IMemoryStore`, SQLite, and sqlite-vec. That is a good abstraction start, but I did not find a production remote memory backend implementation.

Gap:

- No remote durable vector database backend.
- No dual-write/backfill/parity-check migration tooling.
- No cloud VDB config and credential handling.

Suggested upgrade:

- Keep the local SQLite default.
- Research remote backend options:
  - PostgreSQL + pgvector
  - Qdrant
  - LanceDB
  - Neo4j/FalkorDB for graph
  - Tencent Cloud VectorDB only if the deployment target needs it
- Build remote backend only after export/import/audit exist.

### 5. Diagnostics export

TencentDB has a diagnostic export workflow that packages logs, L0-L3 data, SQLite database, checkpoints, backups, and redacted config.

BrainRouter does not appear to have a comparable support bundle.

Gap:

- No one-command support bundle.
- No redaction policy for diagnostic exports.
- No documented troubleshooting evidence structure.

Suggested upgrade:

- Add `memory_export_diagnostic` tool and CLI.
- Output a local `.zip` or `.tar.gz` containing:
  - server logs
  - memory stats
  - redacted env/config
  - schema version
  - selected user/session data
  - L2/L3 mirrors
  - recent memory operation events
- Require explicit user confirmation before including raw L0 content.

## What BrainRouter Has That The Alternatives Do Not Emphasize

### 1. Skill-router-native memory

BrainRouter's `skill_context` type and skill hint registration are a strong differentiator. The alternatives focus on general agent memory; BrainRouter can use memory to improve skill selection and execution quality.

Keep investing here.

Suggested improvements:

- Skill-specific recall reports:
  - which memories influenced skill selection
  - which skill hints were injected
  - which skill contexts were cited
- Skill performance metrics:
  - success/failure by skill
  - common user corrections by skill
  - skill-context memories with high citation rate

### 2. Contradiction detection as a first-class layer

BrainRouter has explicit L1.5 contradictions and user/admin routes. That is stronger than many general memory systems.

Suggested improvements:

- Add contradiction provenance:
  - conflicting record IDs
  - exact extracted claims
  - source L0 snippets
  - proposed resolution
- Add resolution outcomes:
  - prefer A
  - prefer B
  - merge
  - expire both
  - ask user next time

### 3. ACE feedback loop

BrainRouter already tracks whether recalled memories were cited. This is valuable and should be expanded.

Suggested improvements:

- Track per-query recall impressions.
- Track citation precision:
  - recalled
  - cited
  - ignored
  - later contradicted
- Use this to tune ranking and auto-archive policies.

## Priority Upgrade Plan

### Phase 1: Trust and operability

Do this before adding exotic memory features.

- Add audit table and audit writes.
- Add privacy/redaction filter before L0 capture.
- Add export/import.
- Add governance delete.
- Add diagnostic export.
- Add benchmark README and consistent result artifact format.
- Add dashboard/API for operation logs and recall diagnostics.

### Phase 2: Observability and replay

- Add memory operation event log.
- Add timeline/session pages.
- Add recall explainability:
  - FTS hits
  - vector hits
  - RRF score
  - decay score
  - skill boost
  - reranker result
  - graph expansion
- Add session replay for captured L0 and memory operations.

### Phase 3: Short-term context offload

- Build TencentDB-style working memory offload:
  - raw refs
  - step JSONL
  - Mermaid canvas
  - node_id/result_ref drill-down
- Add token-pressure triggers.
- Add a `memory_working_context` tool that returns the compact canvas and lets the agent request raw refs.

### Phase 4: Host integrations

- Codex lifecycle hooks.
- Claude Code lifecycle hooks.
- OpenClaw/Hermes adapters if those are target users.
- Passive capture so memory does not depend only on tool calls made by the model.

### Phase 5: Multi-agent and remote backend

- Action/frontier/lease tools if BrainRouter will coordinate multiple agents.
- Remote backend abstraction with dual-write migration.
- Team sharing and mesh only after governance is strong.

## Research Backlog

These items need more research before implementation:

- Best local-first event schema for replay and operation observability.
- Whether Mermaid canvas is the right symbolic format for BrainRouter or whether a stricter JSON graph plus rendered Mermaid is safer.
- How to prevent short-term offload from hiding important failure details from the agent.
- Which privacy filters are strong enough before raw L0 storage.
- How to evaluate memory quality beyond retrieval metrics:
  - task success
  - fewer repeated user corrections
  - fewer irrelevant memory injections
  - contradiction resolution quality
- Best remote backend:
  - pgvector for boring durability
  - Qdrant/LanceDB for vector-first search
  - FalkorDB/Neo4j for graph-heavy recall
  - hybrid architecture with SQLite local cache and cloud sync
- Whether to make L2/L3 Markdown mirrors canonical or derived-only.
- How ACE citation feedback should interact with decay, archive, and contradiction resolution.

## Recommended Next Step

Create a concrete implementation plan for Phase 1 only:

1. Audit schema and write points.
2. Privacy/redaction filter.
3. Export/import format.
4. Governance delete.
5. Diagnostic export.
6. Recall/capture event log.
7. Benchmark result format.

This would make BrainRouter safer to debug and operate before expanding the feature surface.


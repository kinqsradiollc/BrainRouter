# BrainRouter: Software Engineering Memory System — Task Tracker

Status: **Phase 2 Implemented — Benchmark Verification Pending**

---

## Phase 1 — Trust & Auditability

### 1.1 Type System [x]
- [x] Extend `L1Record` in `packages/types/src/memory.ts` with `confidence`, `status`, `sourceKind`, `verificationStatus`, `repoPaths`, `filePaths`, `commands`
- [x] Add `EvidenceRef`, `MemoryEvidence`, `MemoryOperation` interfaces to `packages/types/src/memory.ts`
- [x] Add `MemoryExport` / `MemoryImport` envelope interfaces
- [x] Add new `IMemoryStore` methods to `packages/types/src/store.ts`

### 1.2 SQLite Schema Migration
- [x] Add `memory_evidence` table to `mcp/src/memory/store/sqlite.ts`
- [x] Add `memory_operations` audit table to `mcp/src/memory/store/sqlite.ts`
- [x] Add new columns to `l1_records`: `confidence`, `status`, `source_kind`, `verification_status`, `repo_paths_json`, `file_paths_json`, `commands_json`
- [x] Implement all new `IMemoryStore` methods in `SqliteMemoryStore`

### 1.3 Engine Passthroughs
- [x] Add `getMemoryById`, `addEvidence`, `getEvidence`, `updateMemoryStatus` to `mcp/src/memory/engine.ts`
- [x] Add `exportMemories`, `importMemories`, `governanceDelete` to engine
- [x] Wire audit log writes to all significant mutations (L1 upsert, archive, delete, contradiction resolve)

### 1.4 Privacy Redaction
- [x] Create `mcp/src/memory/redaction.ts` with regex-based filter (API keys, bearer tokens, PEM blocks, .env secrets)
- [x] Wire redaction filter into L0 capture path in `capture.ts`

### 1.5 Governance MCP Tools
- [x] Create `mcp/src/tools/memory-governance.ts` with:
  - [x] `memory_get`
  - [x] `memory_update`
  - [x] `memory_evidence_add`
  - [x] `memory_evidence_get`
  - [x] `memory_export`
  - [x] `memory_import`
  - [x] `memory_governance_delete`
  - [x] `memory_audit`
- [x] Register new tools in the MCP server

### 1.6 HTTP API Routes
- [x] `GET /api/memories/:recordId`
- [x] `PATCH /api/memories/:recordId`
- [x] `POST /api/memories/:recordId/evidence`
- [x] `GET /api/memories/:recordId/evidence`
- [x] `GET /api/export`
- [x] `POST /api/import`
- [x] `DELETE /api/memories/:recordId`
- [x] `GET /api/audit`

### 1.7 Phase 1 Verification
- [x] `npm run build` passes with no type errors
- [x] New SQLite tables created on engine init
- [x] Redaction strips `Bearer sk-test-key` from L0
- [x] Export/import round-trip preserves all L1 records
- [x] Governance delete writes to operations log

---

## Phase 2 — Engineering-Specific Memory Types

### 2.1 Expanded Memory Type Union
- [x] Expand `MemoryType` in `packages/types/src/memory.ts` to 29 types (see plan)
- [x] Update all type guards, switches, and discriminated unions in codebase

### 2.2 Type Configuration
- [x] Create `mcp/src/memory/memory-type-config.ts` with per-type decay, confidence, evidence requirements, and recall intent affinity

### 2.3 Extraction Prompt
- [x] Update `mcp/src/memory/prompts/l1-extraction.ts` with all engineering types and gated extraction strategy
- [x] Add `confidence` scoring guidance and `sourceKind` classification rules
- [x] Add `filePaths`, `commands`, `repoPaths` extraction instructions

### 2.4 File Index
- [x] Add `memory_file_index` table to SQLite store
- [x] Populate `memory_file_index` on every L1 upsert (extract from `filePaths`)
- [x] Add `getMemoriesByFilePath(userId, filePath, limit)` store method

### 2.5 Engineering MCP Tools
- [x] Create `mcp/src/tools/memory-engineering.ts` with:
  - [x] `memory_debug_trace_save`
  - [x] `memory_debug_trace_search`
  - [x] `memory_failed_attempts`
  - [x] `memory_file_history`
  - [x] `memory_task_state`
  - [x] `memory_task_update`
  - [x] `memory_handover`
  - [x] `memory_verify`
- [x] Register new tools in the MCP server

### 2.6 Intent-Aware Recall
- [x] Add task-intent detection in `mcp/src/memory/recall.ts`
- [x] Implement type-aware ranking policy (per-intent type boosts)
- [x] Add file-path based recall expansion via `memory_file_index`

### 2.7 Phase 2 Verification
- [x] MCP `memory_debug_trace_save` produces `bug_finding`, `debug_trace`, `fix_summary`, and `verification_result` L1 types
- [x] `memory_file_history` returns hits for a known file path
- [x] MCP tool list advertises all Phase 2 engineering tools
- [x] `npm run build` passes in `packages/types` and `mcp`
- [x] `npm test` passes in `mcp` (231 tests)
- [x] `debug` intent query ranks `bug_finding` above `persona` in RRF
- [x] LongMemEval R@5 does not regress (FTS R@5 97.0%, equal to 2026-05-17 baseline)

---

## Phase 3 — Observability & Recall Explainability

### 3.1 Recall Explanation
- [ ] Add `recallExplanation` to `RecallResult` type in `packages/types/src/memory.ts`
- [ ] Populate `recallExplanation` in `mcp/src/memory/recall.ts`
- [ ] Write recall query row to `memory_operations` after each recall

### 3.2 Explain Tool
- [ ] Create `mcp/src/tools/memory-explain.ts` with `memory_explain_recall` tool
- [ ] Register tool in MCP server

### 3.3 Dashboard — Timeline Page
- [ ] Create `dashboard/app/timeline/page.tsx`
  - [ ] List `memory_operations` events (capture, extraction, recall, archive, export, delete)
  - [ ] Filter controls: user, session, operation type, time range
  - [ ] Show latency and hit counts for recall events
- [ ] Add API route `GET /api/operations` with pagination

### 3.4 Dashboard — Recall Inspector Page
- [ ] Create `dashboard/app/recall-inspector/page.tsx`
  - [ ] Input: query text + userId
  - [ ] Output: ranked memories with per-memory score breakdown
- [ ] Wire to new `memory_explain_recall` tool or API route

### 3.5 Dashboard — Evidence Browser Page
- [ ] Create `dashboard/app/evidence/page.tsx`
  - [ ] List all evidence rows for a user
  - [ ] Filter by evidence kind
  - [ ] Click-through from evidence to parent memory
- [ ] Add API route `GET /api/evidence` with pagination and filters

### 3.6 Phase 3 Verification
- [ ] Recall inspector returns populated `recallExplanation` for a known query
- [ ] Timeline page renders `memory_operations` rows with correct timestamps
- [ ] Evidence browser shows rows attached via `memory_evidence_add`

---

## Phase 4 — Short-Term Working Memory

### 4.1 Working Memory Core
- [ ] Create `mcp/src/memory/working/offload.ts` — token pressure detection + payload offload
- [ ] Create `mcp/src/memory/working/canvas.ts` — Mermaid task canvas management
- [ ] Create `mcp/src/memory/working/step-log.ts` — JSONL step summaries

### 4.2 Working Memory Tools
- [ ] Create `mcp/src/tools/memory-working.ts` with:
  - [ ] `memory_working_context`
  - [ ] `memory_working_offload`
  - [ ] `memory_working_reset`
- [ ] Register tools in MCP server

### 4.3 Token Pressure Triggers
- [ ] Mild trigger (>50%): compress step log, keep only last 5 nodes in injected state
- [ ] Aggressive trigger (>85%): full offload, inject only canvas + current node summary

### 4.4 Phase 4 Verification
- [ ] 100-tool-call session: refs files written, canvas.mmd updates
- [ ] `memory_working_context` returns canvas without raw payloads
- [ ] Aggressive offload triggers correctly

---

## Phase 5 — Host Integrations

### 5.1 Integration Adapters
- [ ] Create `mcp/src/integrations/claude-code.ts` — PreToolUse, PostToolUse, Stop, SubagentStop hooks
- [ ] Create `mcp/src/integrations/codex.ts` — session start/end, prompt submit, compact hooks
- [ ] Create `mcp/src/integrations/generic-mcp.ts` — generic passive capture adapter

### 5.2 Hook Management Tools
- [ ] Add `memory_hook_register` tool
- [ ] Add `memory_hook_status` tool
- [ ] Register tools in MCP server

### 5.3 Phase 5 Verification
- [ ] Claude Code hook registered; simulated PostToolUse writes filtered L0 record
- [ ] Redaction removes `sk-` prefixed keys before L0 storage

---

## Phase 6 — Measurement & Benchmarks

### 6.1 Benchmark Infrastructure
- [ ] Create `mcp/benchmark/README.md` with datasets, modes, metrics, commands, expected artifacts
- [ ] Standardize existing benchmark scripts to write to `results/<run-id>/summary.json`
- [ ] Add `results/<run-id>/recall-trace.jsonl` output to existing recall benchmarks
- [ ] Add `results/<run-id>/extraction-trace.jsonl` output to extraction benchmarks

### 6.2 Benchmark MCP Tools
- [ ] Add `memory_benchmark_run` tool
- [ ] Add `memory_benchmark_results` tool
- [ ] Register tools in MCP server

### 6.3 Dashboard — Benchmarks Page
- [ ] Create `dashboard/app/benchmarks/page.tsx`
  - [ ] List past runs with key metrics
  - [ ] Token savings trend chart
  - [ ] R@5 / R@10 trend chart
  - [ ] Per-run drill-down with recall trace

### 6.4 Phase 6 Verification
- [ ] `npm run benchmark:longmemeval` writes `results/<run-id>/summary.json`
- [ ] Token savings metric populated

---

## Completion Criteria

All phases complete when:
1. `npm run build` passes across the full workspace
2. All MCP tools listed in Phase 1–4 are registered and responsive
3. Dashboard has Timeline, Recall Inspector, Evidence, and Benchmarks pages
4. LongMemEval R@5 is equal to or better than pre-upgrade baseline
5. Token savings metric shows measurable improvement vs naive history injection

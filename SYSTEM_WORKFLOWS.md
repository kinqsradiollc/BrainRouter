# BrainRouter — System Workflows & Architecture

> Architecture reference — a top-to-bottom map of how every part of BrainRouter flows: the two
> frontends, the agent turn engine, the cognitive-memory server, multi-agent delegation, extensions,
> and federation. Every box is anchored to real `file:line` so you can jump into the code.

---

## Table of contents

1. [The 10,000-ft picture](#1-the-10000-ft-picture)
2. [Package map](#2-package-map)
3. [Frontend A — Desktop (Electron)](#3-frontend-a--desktop-electron)
4. [Frontend B — CLI (Ink TUI)](#4-frontend-b--cli-ink-tui)
5. [The Agent turn lifecycle (the heart)](#5-the-agent-turn-lifecycle-the-heart)
6. [Tool dispatch, exec policy & hooks](#6-tool-dispatch-exec-policy--hooks)
7. [Multi-agent: how a complex task fans out](#7-multi-agent-how-a-complex-task-fans-out)
8. [Memory engine — RECALL pipeline](#8-memory-engine--recall-pipeline)
9. [Memory engine — CAPTURE / extraction pipeline](#9-memory-engine--capture--extraction-pipeline)
10. [Memory storage & concurrency](#10-memory-storage--concurrency)
11. [Extensibility — extensions, providers, packs, trust](#11-extensibility--extensions-providers-packs-trust)
12. [Federation — multi-CLI / cross-agent messaging](#12-federation--multi-cli--cross-agent-messaging)
13. [End-to-end: one user message, all the way down](#13-end-to-end-one-user-message-all-the-way-down)
14. [Key file index](#14-key-file-index)

---

## 1. The 10,000-ft picture

BrainRouter is **one core agent engine** (`packages/core`) driven by **two interchangeable frontends**
(Desktop Electron app, CLI TUI), talking to **one cognitive-memory MCP server** (`brainrouter/`) plus any
third-party MCP servers, over an **OpenAI-compatible** provider wire. Extensions, packs, and a
workspace-trust gate layer on top.

```mermaid
graph TB
  subgraph Frontends
    CLI["CLI — Ink TUI<br/>brainrouter-cli"]
    DESK["Desktop — Electron<br/>brainrouter-desktop"]
  end

  subgraph Core["Agent core — packages/core"]
    AGENT["class Agent + runTurn<br/>agent/agent.ts"]
    REG["Tool registry + executors<br/>tool/*"]
    POL["Exec policy + hooks<br/>exec/*, hooks/*"]
    ORCH["Delegation / workers / workflows<br/>orchestration/*"]
  end

  subgraph MCP["MCP client pool — mcp/mcpPool.ts"]
    BRAIN["BrainRouter memory server<br/>brainrouter/ (stdio child or HTTP)"]
    THIRD["3rd-party MCP servers"]
  end

  subgraph Mem["Cognitive memory engine — brainrouter/src/memory"]
    RECALL["RECALL pipeline<br/>recall.ts"]
    CAPTURE["CAPTURE pipeline<br/>capture.ts"]
    DB["SQLite store<br/>store/sqlite.ts"]
  end

  EXT["Extensions + Packs + Trust<br/>extension/*, pack/*, workspace/*"]
  PROV["Provider catalog<br/>provider/* — models from /models"]

  CLI --> AGENT
  DESK --> AGENT
  AGENT --> REG --> POL
  AGENT --> ORCH
  AGENT --> MCP
  BRAIN --> RECALL & CAPTURE
  RECALL --> DB
  CAPTURE --> DB
  EXT -. contributes tools+providers+hooks .-> AGENT
  PROV --> AGENT
  AGENT -->|"recall (pre-turn)"| BRAIN
  AGENT -->|"capture (post-turn)"| BRAIN
```

**The one idea to hold onto:** the Desktop and the CLI add *no* memory logic of their own. Both construct
the **same** `Agent` and both reach memory through the **same** `memory_*` MCP tools served by the
bundled `brainrouter` server. Everything below is just "who calls `Agent.runTurn`, and what `runTurn` does."

---

## 2. Package map

| Package | Role | Ships from |
|---|---|---|
| `packages/core` | The Agent engine: `runTurn`, tool registry, exec policy, hooks, delegation, providers, extensions, trust, sessions, config. | `dist/` (gitignored; CI rebuilds) |
| `packages/agent-protocol` | The typed message contract between a frontend and the agent host. | `dist/` |
| `brainrouter/` | The **cognitive memory MCP server** (recall + capture + SQLite + embeddings/reranker/judge). Runs as a stdio child or HTTP. | `dist/` |
| `brainrouter-cli/` | Ink/TUI shell + slash-command router. Thin — imports the core `Agent`. | `dist/` |
| `brainrouter-desktop/` | Electron app: main process + per-workspace agent host (`utilityProcess`) + React renderer. | `dist-electron/` **tracked**, `dist/` renderer build |

---

## 3. Frontend A — Desktop (Electron)

**Three OS processes.** The agent does **not** run in the main process — each workspace gets its own
`utilityProcess` host.

```mermaid
graph LR
  subgraph R["Renderer (React)"]
    APP["App.tsx — submit() / q() / onAction()"]
    EV["useAgentEvents.ts"]
  end
  subgraph P["preload.cts (contextBridge)"]
    BR["window.brainrouter.*"]
  end
  subgraph M["Electron main — main.ts"]
    POOL["Host pool by workspaceRoot<br/>WinPool"]
    TRUST["Workspace-trust enforcement"]
  end
  subgraph H["Agent host — utilityProcess (host.ts + hostCore.ts)"]
    CORE["hostCore: agent pool by sessionKey"]
    AG["new Agent(...) — packages/core"]
    Q["queries map + action:* handlers"]
  end

  APP -->|"send(agent-command)"| BR
  BR -->|"ipcRenderer.send"| M
  M -->|"host.postMessage"| H
  CORE --> AG
  AG -->|"events"| CORE
  CORE -->|"port.postMessage"| M
  M -->|"webContents.send(agent-event, +workspaceRoot tag)"| EV
  APP -->|"invoke: workspace:* / dashboard:global"| M
  BR -. browser-dev mirror .-> APP
```

Anchors: host fork `main.ts:142`; agent build `host.ts:506-510`; command router `hostCore.ts:334`;
the **single** agent channel is `agent-command`/`agent-event` (`main.ts:279/161`) — every "query" and every
`action:*` is *not* its own IPC channel, it rides inside `{kind:'query', name}` over that one channel.

**User-message sequence (Desktop):**

```mermaid
sequenceDiagram
  participant U as User
  participant App as Renderer App.tsx
  participant Main as Electron main
  participant Host as utilityProcess host
  participant Agent as core Agent.runTurn
  participant Brain as memory MCP

  U->>App: type + Enter (submit, App.tsx:629)
  Note over App: /slash routed locally, never hits the LLM
  App->>Main: send {kind:start-turn, prompt} (agent-command)
  Main->>Host: host.postMessage (active host only, main.ts:285)
  Host->>Agent: agent.runTurn(prompt, callbackBridge) (hostCore.ts:221)
  Agent->>Brain: memory_recall (pre-turn) → emits memory/briefing
  Agent-->>Host: assistant-delta / tool-start / tool-end (stream)
  Host-->>Main: port.postMessage(stamped events)
  Main-->>App: agent-event (+workspaceRoot tag, main.ts:160)
  App-->>U: live tokens, tool cards, recalled-records row
  Agent->>Brain: memory_capture_turn (post-turn) → status deferred
  Agent-->>App: turn-complete (+ tokens-updated)
```

**Modes** (`App.tsx:134`, default `code`): **Chat** = read-only stance (re-asserts `action:set-access {mode:'read'}`),
**Code** = full IDE surface (`shell` access), **Track** = Jira-class PM view firing `track-*` queries.
**Settings** read config via the `config-snapshot` query (secrets scrubbed, `host.ts:1914`); writes via `action:*`
handlers into the **same** `~/.config/brainrouter/config.json` the CLI uses. Secrets never cross to the renderer
(`scrubCliSecrets`, `host.ts:109`; provider keys sent as `hasKey:boolean`).

---

## 4. Frontend B — CLI (Ink TUI)

The CLI is a **thin TUI shell + slash router**; the `Agent`, sessions, federation, MCP, and memory all live
in `packages/core`.

```mermaid
flowchart TD
  START["brainrouter chat (default cmd)<br/>index.ts:138"] --> WS["findWorkspaceRoot()"]
  WS --> WIZ{"onboarded?"}
  WIZ -- no --> RUNWIZ["runWizard → write config.json"] --> EXIT0["exit"]
  WIZ -- yes --> CFG["hydrateConfigDefaultsOnDisk + loadConfig"]
  CFG --> MCPSEL["select MCP profile<br/>thread --root into stdio args"]
  MCPSEL --> CONN["new McpClientPool().connectAll(servers, llm)"]
  CONN --> EXTLOAD["loadExtensions(workspaceRoot, version)<br/>index.ts:269"]
  EXTLOAD --> NEWAG["new Agent(mcpClient, llm, workspaceRoot)"]
  NEWAG --> FED["resolveFederationSessionKey + attachFederation"]
  FED --> TUI["runChat() → Ink <ChatApp>"]
  TUI --> SUBMIT["onSubmit"]
  SUBMIT -->|"# note"| NOTE["memory_capture_turn (no LLM)"]
  SUBMIT -->|"! cmd"| BANG["sandboxed shell"]
  SUBMIT -->|"/cmd"| SLASH["dispatchSlash → repl.ts ordered chain"]
  SUBMIT -->|"plain text"| TURN["runChatTurn → agent.runTurn(...)"]
```

Anchors: boot `index.ts:148-336`; `runChatTurn`→`agent.runTurn` `runChat.tsx:662`; slash chain
`repl.ts:132-151` (first match wins, ends at `tryHandleExtensionCommand` for `/ext` `/trust` `/update`,
then custom markdown commands from `.brainrouter/commands/<name>.md`).

**Memory is out-of-process:** the default profile spawns `brainrouter-mcp` as a **stdio child**
(`wizard/runner.ts:410`), reached through `McpClientWrapper` (`StdioClientTransport`) — never in-process.
`--root <workspaceRoot>` is threaded into its args at boot.

---

## 5. The Agent turn lifecycle (the heart)

This is what both frontends ultimately call. `Agent.runTurn` (`agent/agent.ts:1051`) is a **streaming agentic
loop** with a durable transcript, pre-turn memory recall, a strategy planner, enforce/advisory hook fire-points,
and post-turn memory capture.

```mermaid
flowchart TD
  A0["runTurn(prompt)"] --> A1["bootstrapSession (1st turn)"]
  A1 --> A2["★ recordTranscript(user) — durable BEFORE anything<br/>agent.ts:1072"]
  A2 --> A3["listTools() + build tool surface<br/>registryAllowedTools(mode) + MCP budget + delegate tools"]
  A3 --> A4{"prompt tokens > autoCompactTokens?"}
  A4 -- yes --> A4c["compactHistory()"]
  A4 --> A5["★ injectRecallContext(prompt) — MEMORY RECALL<br/>agent.ts:1236"]
  A4c --> A5
  A5 --> A6["hooks: pre-turn (advisory)"]
  A6 --> A7{"hook user-prompt-submit (ENFORCE)"}
  A7 -- deny --> AX["return 'Prompt blocked…'"]
  A7 -- allow --> A8["next-action planner (low-effort classifier)<br/>answer-direct / investigate / fan-out / workflow"]
  A8 --> A9["push goal-anchor + user msg + drain child completions"]

  A9 --> L0{"MAIN LOOP — maxLoops≈60"}
  L0 --> L1["invokeLlmResilient: sanitizeToolCallPairing → callOpenAIStream<br/>reconnect on 5xx/429/offline; compact on overflow"]
  L1 --> L2["ToolCallRepair: scavenge → truncation → storm-suppress"]
  L2 --> L3["★ push assistant msg + recordTranscript"]
  L3 --> B{"assistant returned tool_calls?"}

  B -->|NO| N1["drain unobserved children → wait_agents"]
  N1 --> N2["preambleGuard / promise-then-ask / fan-out / child-synthesis guards"]
  N2 --> N3{"guard fired?"}
  N3 -- yes --> L0
  N3 -- no --> DONE["finalAnswer = sanitize(content) → BREAK"]

  B -->|YES| C1["repeat-SEQUENCE guard (mutations exempt)"]
  C1 --> C2["mark parallel-safe per call (toolSafety)"]
  C2 --> C3["processOneToolCall(tc) for each — see §6"]
  C3 --> C4["partition: consecutive safe → runSafeBatch (allSettled)<br/>serial calls one-by-one"]
  C4 --> C5["★ push results IN ORIGINAL ORDER + transcript<br/>synthesize orphan results (pairing)"]
  C5 --> L0

  DONE --> P4["★ captureTurn(prompt, answer) — MEMORY CAPTURE (backgrounds extraction)<br/>agent.ts:2935"]
  P4 --> P5["hooks: post-turn (advisory) + usage rollup + shrink oversized results"]
  P5 --> RET["return finalAnswer"]
```

**Why the ★ ordering matters:**
- The **user message is written to the transcript first** (`agent.ts:1072`) — before recall, planner, or LLM —
  so a mid-turn crash never loses it, and tool-call pairing stays intact on resume.
- **Recall is pre-turn** (injects a `<relevant-memories>` block), **capture is post-turn** (and backgrounds the
  heavy cognitive extraction so the reply never blocks).
- Tool **results are appended in original call order** even when executed in parallel, so the next LLM turn sees a
  deterministic transcript. Every `tool_call` is guaranteed a paired result (dedupe + storm-synthetics +
  `synthesizeOrphanResults`), or the provider 400s.

**Resilience baked into the loop:** transient 5xx/429/timeout/offline → bounded reconnect (honors `Retry-After`,
offline waits don't spend budget); context-overflow → reactive `compactHistory()` + retry; model-not-found →
fallback model; `<<<NEEDS_HIGH>>>` → self-escalate up the provider tier ladder (≤2/turn).

---

## 6. Tool dispatch, exec policy & hooks

### 6.1 One registry, three derived views

```mermaid
flowchart LR
  REG["LOCAL_TOOL_REGISTRY<br/>tool/registry.ts:37<br/>name · accessTier · actionKind · parallelSafe"]
  EXT["extensionToolEntries()"]
  EFF["effectiveToolRegistry() = REG ++ EXT"]
  REG --> EFF
  EXT --> EFF
  EFF --> V1["registryAllowedTools(mode)<br/>exposure by tier"]
  EFF --> V2["registryParallelSafeLocal()<br/>→ PARALLEL_SAFE_LOCAL_TOOLS"]
  EFF --> V3["localToolExecutors()<br/>name → executor"]
```

All three views are **generated** from the single registry (drift-guarded by `tool-registry.test.ts` +
`assertLocalToolExecutorInvariants`). Extensions register a tool **at** a tier and flow through the identical
exposure/parallel/policy path — they cannot bypass the tier.

### 6.2 The per-tool-call gauntlet — `processOneToolCall` (`agent.ts:2383`)

```mermaid
flowchart TD
  T0["tool call (name, args)"] --> T1["classifyForVerification (mutated/verified bookkeeping)"]
  T1 --> T2["parseArguments — malformed JSON → structured error"]
  T2 --> T3["identical-args repeat guard"]
  T3 --> H1{"HOOK pre-tool (ENFORCE)<br/>ext + shell + Hookify"}
  H1 -- deny --> THROW["throw 'Blocked by pre-tool hook'"]
  H1 -->|"allow — updatedInput rewrites args"| POL{"EXEC POLICY"}
  POL --> P1["cli.permissions rules (deny blocks; allow downgrades an ask)"]
  P1 --> P2["resolveToolPolicy(name, mode, args)<br/>deny→throw; ask+silent→throw (fail-closed)"]
  P2 --> P3["external-dir gate for file_edit escaping workspace"]
  P3 --> D{"DISPATCH LANE"}
  D -->|orchestration| O["executeOrchestrationTool (delegation/workflow)"]
  D -->|local| LO["executeLocalTool → legacy switch(name)"]
  D -->|MCP| MC["applyFederationIdentity → mcpClient.callTool"]
  O --> POST["post-tool hooks (advisory) + compact result + cache"]
  LO --> POST
  MC --> POST
  POST --> RET["return toolMsg + fullResultText + systemMsg"]
```

### 6.3 Exec-policy matrix — `decideExecutionPolicy(actionKind, mode)` (`exec/execPolicy.ts:27`)

| ActionKind | `read` mode | `write` mode | `shell` mode |
|---|---|---|---|
| `read_only` / `network` / `bg` | ✅ allow | ✅ allow | ✅ allow |
| `file_edit` / `child_write` | ⛔ deny | ✅ allow | ✅ allow |
| `shell` | ⛔ deny | ⛔ deny | ✅ allow |

Unknown tool → `read_only` (safe default; MCP `memory_*` land here, usable in every mode). A child spawn's
action-kind is resolved from the **child's requested access**, and `clampAccess(parent, requested)` guarantees
child ≤ parent.

### 6.4 Hook fire-points

| Event | Where (`agent.ts`) | Enforce / Advisory | Effect |
|---|---|---|---|
| `pre-turn` | 1240 (shell) + 1241 (ext) | advisory | informational |
| `user-prompt-submit` | 1247 (ext) + 1249 (shell) | **enforce** | deny → turn returns before any LLM call; runs even for silent agents |
| `pre-tool` | 2475 (ext) + 2477 (shell) + 2496 (Hookify) | **enforce** | deny / non-zero / block → tool throws; `updatedInput` rewrites args |
| `post-tool` | 2742 (shell) + 2746 (ext) | advisory | informational |
| `post-turn` | 2937 (shell) | advisory | gets answer preview + token usage |
| `pre-compact` | 3872 (shell) | advisory | before `compactHistory()` |

Two gates decide whether hooks run: `hookEnforceActive()` (blocking events run even unattended/headless if
`enforceWhenSilent`) and `hookAdvisoryActive()` (advisory = interactive only). Extension hooks are typed,
in-process handlers (`runExtensionHooks`); a thrown handler is swallowed (never blocks), a returned `'deny'` blocks.

---

## 7. Multi-agent: how a complex task fans out

When the planner picks `fan-out` / `workflow`, or the model calls a delegation tool, the agent spawns child
`Agent`s. The model sees `task_agent` (foreground/blocking), `delegate_agent` (background), synthesized
`delegate_<id>` tools, plus `spawn_agents` / `run_workflow` / worker tools.

```mermaid
flowchart TD
  M["parent Agent turn"] --> SPAWN["handleSpawn (orchestration/tools.ts:623)"]
  SPAWN --> G1["spawn-slot gate (cli.maxConcurrentChildren)"]
  G1 --> G2["access = clampAccess(parent, requested) — child ≤ parent"]
  G2 --> G3{"delegation policy gate"}
  G3 -->|no-children| DENY["deny"]
  G3 -->|"ask-* or auto"| SESS["createSession → ChildSessionRecord<br/>resolve child workspace (per-child git worktree?)"]
  SESS --> CTX["typed parent-context snapshot<br/>briefing + recalled ids + goal + plan + ownership glob"]
  CTX --> CHILD["new Agent(silent, enableRecall, accessMode, depth+1, parentTrace)"]
  CHILD --> RUN["detached IIFE: childAgent.runTurn(...)"]
  RUN --> W{"wait?"}
  W -->|"task_agent — wait"| INTURN["await → result returned IN-TURN"]
  W -->|"delegate_agent — no wait"| NEXT["enqueueCompletion → delivered to parent's NEXT turn (drainCompletions)"]
  RUN --> DONE["on done: offload large output to working memory<br/>updateSession(completed) + emitRouteFeedback + teardown worktree"]
```

- **`spawn_agents` (grid/batch):** ownership pre-check (write/shell fan-out must declare a non-overlapping
  ownership glob — atomic fail), spawn sequentially but **children run in parallel**; `wait_agents` awaits all
  with `allSettled` (one failure ≠ whole-batch fail).
- **Model-spawned workers** (`spawnWorkerThread`): durable detached `Agent` (`tier:'worker'`) that **outlives the
  turn**, persists status to `workerStore.ts`, depth-capped at `MAX_WORKER_DEPTH=1`. Orphans flip `running→failed`
  on restart (no fake resume).
- **Workflows** (`run_workflow`): a declarative `PhasePlan` whose children go through the same spawn/wait path;
  **blocked for silent/child agents** (no recursive runaway) and gated by a cost confirmation.
- **Task planning:** `update_plan` persists a `PlanState` to `tasks.json` and renders the live ✓/⏳/☐ checklist;
  `planSyncGuard` + `taskTrackingNudge` force multi-step work to keep the plan in sync.

---

## 8. Memory engine — RECALL pipeline

`MemoryRecallPipeline.recall` (`brainrouter/src/memory/recall.ts:414`). Four headline stages
(**retrieve → rerank/select → judge → graph**) with fusion/scoring/spreading-activation between them. **RRF is
the safety net** — if vector, reranker, and judge are all down, FTS+filepath fused by RRF still returns results.

```mermaid
flowchart TD
  Q["query + sessionKey + filters"] --> S1a["Stage 1a — keyword FTS5/BM25<br/>searchCognitiveFts"]
  Q --> S1b["Stage 1b — filepath hints"]
  Q --> S1c{"embeddings ready?"}
  S1c -- yes --> S1cv["Stage 1c — vector search (cosine)<br/>embed(query) → searchCognitiveVec"]
  S1c -->|"no or error"| SKIPV["skip → FTS-only"]

  S1a --> FILT["applyFilters on each stream<br/>★ session-scope artifact/annotation kinds"]
  S1b --> FILT
  S1cv --> FILT
  SKIPV --> FILT
  FILT --> EMPTY{"all empty?"}
  EMPTY -- yes --> RET0["return early (keyword-empty / hybrid-empty)"]
  EMPTY -- no --> RRF["Stage 1.5 — RRF fusion (k=60 fts/vec, k=45 file)"]
  RRF --> SCORE["Stage 1.6 — score = half-life decay × skill/intent/citation boosts"]
  SCORE --> SPARK["Stage 1.7 — Neural Sparks (spreading activation over cognitive_connections)"]
  SPARK --> POOL["pools: topResults(5) + rerankCandidates(20)"]

  POOL --> S2{"Stage 2 — reranker available & not reflective?"}
  S2 -- yes --> RERANK["cross-encoder /v1/rerank (char-budgeted head)<br/>blend by reciprocal rank"]
  S2 -- no --> MMR["Stage 2b — local lexical + MMR diversity selection (zero network)"]
  RERANK --> S3
  MMR --> S3

  S3{"Stage 3 — relevance judge ready & enabled?"}
  S3 -- yes --> JUDGE["LLM judge → mode 'reorder' (default, recall-safe) or 'filter' (min-keep floor)"]
  S3 -- no --> NOJUDGE["unchanged"]
  JUDGE --> REFS
  NOJUDGE --> REFS
  REFS["gather refs + sink stale-vs-code records<br/>format <relevant-memories> + recall compression"]
  REFS --> S4["Stage 4 — graph expansion (2-hop BFS) → KNOWLEDGE GRAPH CONTEXT"]
  S4 --> AUDIT["strategy label + writeRecallOp → RecallResult"]
```

**Key correctness points:**
- `applyFilters` (`recall.ts:348`) drops `kind ∈ {artifact, annotation}` unless `record.session_key === sessionKey`
  — **artifacts/annotations are session-scoped** even when no filter is supplied.
- The judge defaults to **`reorder`** (approved first, rest demoted not dropped) with a min-keep floor, so the
  ranking stages can never zero-out a query that had candidates.
- Reflective/"how do I feel"-style queries **skip the reranker** (MEM-ROUTE) and ride the local MMR path.

---

## 9. Memory engine — CAPTURE / extraction pipeline

`MemoryCapturePipeline` (`brainrouter/src/memory/capture.ts`). Split into a **fast synchronous part** (write raw
sensory rows, reply immediately) and a **backgrounded heavy part** (LLM cognitive extraction → commit). This is
the non-blocking design that stops the MCP reply from hanging on the LLM.

```mermaid
flowchart TD
  CT["captureTurn(messages) — SYNC, replies fast"] --> SENS["redact + upsertSensory (one row per message)"]
  SENS --> SRC["ingest turn sources (idempotent by hash)"]
  SRC --> TRIG{"unextracted ≥ extractEveryN (engine passes 1)?"}
  TRIG -->|no| REPLY["return sensoryRecorded + status"]
  TRIG -->|"yes, not in-flight"| BG["★ background dispatch extractPendingSensory<br/>status = deferred (never blocks reply)"]
  BG --> REPLY

  subgraph HEAVY["extractPendingSensory — BACKGROUND"]
    P1["pull recent sensory window (20)"] --> P2["runAsJob: extractCognitiveMemories → LLM (ModelLLMRunner)"]
    P2 --> BRK{"cognitive breaker open?"}
    BRK -- yes --> FASTFAIL["throw COGNITIVE_BREAKER_OPEN (fast-fail, rows stay queued)"]
    BRK -- no --> PARSE["parseExtractionResult → ParseExtractionOutcome"]
    PARSE --> PF{"parseFailed?"}
    PF -->|"yes — unparseable or bare sensory_ echo"| REQ["recordExtractionFailure ++errors<br/>★ rows NOT marked extracted → sweeper retries"]
    PF -->|"no — genuine empty"| ACCEPT["mark extracted + reset failures"]
    PF -->|"no — scenes"| BUILD["build CognitiveRecord list"]
    BUILD --> DEDUP["dedup → blackboard admission (fail-open)"]
    DEDUP --> COMMIT["upsertCognitive + markCommitted"]
    COMMIT --> BGJOBS["non-blocking: embed → contradiction check → graph extract → dendritic connections → provenance"]
    BGJOBS --> DISTILL["scheduler counters → focus-shift / identity distillation triggers"]
  end

  BG -.-> HEAVY
  SWEEP["extraction sweeper (5-min interval, 30s floor)<br/>engine.ts:1603"] -.->|"backfills stalled (user,session)"| HEAVY
```

**The bug class this guards against** (the `#512`/`#516` fix): the LLM sometimes echoes a bare
`[sensory_<id>, …]` list instead of scene JSON. The old code returned `[]`, looked like "nothing notable", marked
the rows extracted, and **dropped them forever**. Now `parseExtractionResult` returns a discriminated
`{ scenes, parseFailed, reason }` — `parseFailed:true` → `success:false` → rows **stay queued** for the sweeper.
A genuine `[]` is still accepted. A **cognitive circuit breaker** (threshold 3 / 30s cooldown) fast-fails the whole
cognitive chain against a dead endpoint instead of burning each stage's full retry budget; a per-user
`extraction_errors` counter pauses the sweep for a session at 5 failures until a success resets it.

---

## 10. Memory storage & concurrency

**SQLite store** — `brainrouter/src/memory/store/sqlite.ts` (`SqliteMemoryStore`). The tiers:

| Tier | Table(s) | Purpose |
|---|---|---|
| **Sensory** | `sensory_stream` | raw per-message turn log; `extracted_at IS NULL` drives the sweeper |
| **Cognitive** | `cognitive_records` (+ `cognitive_fts` BM25, `cognitive_vec` cosine embeddings) | distilled long-term memories; FTS + vector recall |
| **Graph** | `graph_nodes`, `graph_edges`, `cognitive_connections` | GraphRAG entities/relations + dendritic-spine assoc graph (neural sparks) |
| **Sources** | `source_documents`, `source_chunks` (+ `source_chunks_fts`), `code_symbol_edges`, `cognitive_source_links` | ingested docs/code, chunked + provenance-linked to records |
| **Curation** | `contradictions`, `memory_blackboard_items`, `memory_tree_nodes`, `contextual_focus`, `core_identity` | conflict detection, staged-admission, summary tree, focus scenes, persona |
| **Ops/sched** | `memory_operations`, `memory_jobs`, `scheduler_state` (`extraction_errors`), `memory_evidence`, `memory_file_index` | audit log, observable job queue, per-user counters |
| **Federation** | `users`, `active_sessions`, `session_inbox`, `pending_delegations` | cross-CLI session registry / inbox / delegation |

**Concurrency model** (`brainrouter/src/memory/llm/llm-semaphore.ts` + the new `token-bucket.ts` from #515):

```mermaid
flowchart LR
  subgraph SEM["3 decoupled semaphores"]
    G["generative cap=2<br/>extract/contradiction/graph/focus/identity/judge"]
    E["embedding cap=8<br/>recall query-embed (latency-critical)"]
    R["reranker cap=1<br/>bounded acquire-wait → load-shed to RRF"]
  end
  subgraph BRK["2 circuit breakers"]
    CB["cognitive breaker 3/30s<br/>checked in ModelLLMRunner.run"]
    RB["reranker breaker 3/30s<br/>checked via isAvailable()"]
  end
  G --> CB
  R --> RB
```

The point of **three separate pools**: a latency-critical recall query-embed must never queue behind a slow
background generation (the pre-0.4.15 single-cap-1 stall that produced "client disconnected before reply").
**Bounded timeouts** (embedding 30s, reranker 25s, judge ~15s) are deliberately exempt from the 10-minute local
generative floor so the recall path degrades fast instead of hanging the MCP reply. Background work (extraction,
embed, contradiction, graph, distillation) is dispatched `void`/`.catch` so it never blocks a reply, and three
`setInterval` sweepers (extraction 5m, active-session 1m, inbox 5m) backfill with reentrancy guards + `.unref()`.

---

## 11. Extensibility — extensions, providers, packs, trust

### 11.1 Extension load flow (trust-gated, fault-isolated)

```mermaid
flowchart TD
  L0["loadExtensions(workspaceRoot)<br/>extension/loader.ts:30"] --> L1["resetExtensionContributions()"]
  L1 --> L2["trusted = isWorkspaceTrusted(workspaceRoot) — read once"]
  L2 --> L3["discover + resolve tiers<br/>builtin > user (~/.brainrouter/extensions) > workspace (.brainrouter/extensions)"]
  L3 --> EACH{"for each extension"}
  EACH --> B1{"enabled? (~/.brainrouter/extensions.json, default on)"}
  B1 -- no --> SKIPD["skippedDisabled"]
  B1 -- yes --> B2{"source==workspace AND not trusted?"}
  B2 -- yes --> SKIPU["skippedUntrusted (gate)"]
  B2 -- no --> B3{"entry file exists?"}
  B3 -- no --> ERR["errors"]
  B3 -- yes --> ACT["import(entry) + await activate(host)<br/>try/catch — a throw is logged, NEVER fatal"]
  ACT --> NEXT["activated"]
  NEXT --> EACH
  EACH --> REFRESH{"any activated?"}
  REFRESH -- yes --> RC["refreshProviderCatalog()"]
  REFRESH --> RESULT["ExtensionLoadResult"]
```

### 11.2 How a contribution reaches the agent (three chains)

| Contribution | `activate(host)` call | Reaches the agent via |
|---|---|---|
| **Tool** | `host.registerTool(def)` → `toolContribs` | `effectiveToolRegistry()` (exposure by tier) + `localToolExecutor(name)` **falls through to** `extensionExecutor(name)` |
| **Provider** | `host.registerProvider(def)` → `providerContribs` | `refreshProviderCatalog()` rebuilds `PROVIDER_CATALOG` (a **built-in id always wins** over an extension of the same id) |
| **Hook** | `host.registerHook(handler)` → `hookContribs` | `runExtensionHooks(event, ctx)` at pre-turn / user-prompt-submit / pre-tool / post-tool; `'deny'` blocks |

### 11.3 Providers & packs & trust (the facts)

- **Providers** (`provider/catalog.ts`): every provider is the same OpenAI-compatible wire; `endpoint` is a base
  URL and `callOpenAI` appends `/chat/completions`. **Model lists are always empty in the catalog** — live
  `/models` from the endpoint wins; provider modules are forbidden from owning model catalogs/defaults.
- **Packs** (`pack/packs.ts`): same builtin>user>workspace tiering, but user packs live under
  `~/.config/brainrouter/packs` (note: **different home** from extensions/trust, which are under `~/.brainrouter`).
  Today **only `agents/` is wired** into the agent registry (`commands/skills/hooks/mcp` are declared-but-unconsumed).
  Packs are **opt-in per workspace** (`.brainrouter/packs.json`), not trust-gated.
- **Trust** (`workspace/workspaceTrust.ts`): one global store at `~/.brainrouter/trusted-workspaces.json`, shared
  by CLI + desktop, path-normalized via `realpathSync`. **What it actually gates today: workspace-tier extension
  activation only** (the loader). The docstring mentions shell/hooks aspirationally, but no separate shell/pack-hook
  trust gate is wired in core yet. Desktop auto-trusts the launch workspace (`main.ts:275`); every other workspace
  needs an explicit "Do you trust this folder?" confirmation, enforced defense-in-depth in `workspace:open`.

> **0.4.15 cleanup that landed in this branch:** the extension API originally added a second `getConfigHome()`
> reading `process.env.BRAINROUTER_HOME` and a *duplicate* trust store (`trust/trust.ts`). Both were removed —
> extension dirs now route through the single `getBrainrouterHome()` helper and the one canonical
> `workspace/workspaceTrust.ts`, fixing a split-brain where the desktop launch-trust and the extension gate read
> different files.

---

## 12. Federation — multi-CLI / cross-agent messaging

Each CLI process registers with the brain so multiple terminals/agents can see and message each other. The subtle
part: there are **two session keys**.

| Key | Field | Scope | The LLM sees it? |
|---|---|---|---|
| **Chat key** | `agent.sessionKey` | transcript, memory recall/capture, goals, plans; rotates on `/new`; resolved by the brain via `memory_resolve_session` | ✅ yes (in its system prompt) |
| **Federation key** | `agent.federationSessionKey` | the federation registry/inbox/delegation; fresh `randomUUID()` per process, not persisted | ❌ no |

```mermaid
sequenceDiagram
  participant CLI as CLI process
  participant Brain as memory MCP (federation tables)
  participant Model as the LLM

  CLI->>Brain: session_register (federation key, metadata:{pid})
  loop every 30s
    CLI->>Brain: session_heartbeat (re-register if swept)
  end
  loop every 5s
    CLI->>Brain: session_inbox_read(peek:true) → surface kind:text banners
  end
  Note over Model: model only knows the CHAT key
  Model->>CLI: calls session_inbox_read / session_send (with chat key)
  CLI->>CLI: applyFederationIdentity rewrites sessionKey/from → FEDERATION key (agent.ts:2640)
  CLI->>Brain: corrected federation call
```

The **identity rewrite at the tool-call boundary** (`util/federationIdentity.ts`) is what reconciles the two keys:
the model uses the chat key it knows, and the agent silently substitutes the federation key for
`session_inbox_*` / `session_send` / `session_delegate_task` so messages land in the right registry row.
(Parent↔child agent results use a *separate* in-memory completion inbox keyed by the parent chat key — not federation.)

---

## 13. End-to-end: one user message, all the way down

Putting every layer together — a Desktop user message that triggers a tool, with memory recall and capture:

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant R as Renderer
  participant M as Electron main
  participant H as Agent host
  participant A as Agent.runTurn
  participant Mem as memory MCP (brainrouter)
  participant LLM as Provider (/chat/completions)

  U->>R: type prompt + Enter
  R->>M: agent-command {start-turn}
  M->>H: host.postMessage
  H->>A: runTurn(prompt)
  A->>A: recordTranscript(user) — durable first
  A->>Mem: memory_recall (gated briefing)
  Mem->>Mem: FTS+vector+filepath → RRF → score → spark → rerank → judge → graph
  Mem-->>A: <relevant-memories> block
  A->>A: pre-turn + user-prompt-submit hooks (ENFORCE)
  A->>LLM: callOpenAIStream(history)
  LLM-->>A: assistant + tool_calls
  A-->>R: assistant-delta / tool-start (streamed via host→main)
  A->>A: pre-tool hooks + exec policy gauntlet
  A->>Mem: (if MCP tool) applyFederationIdentity → callTool
  A->>LLM: next loop with tool results (original order)
  LLM-->>A: final answer (no tool_calls)
  A->>Mem: memory_capture_turn (post-turn) → status deferred
  Mem-->>Mem: write sensory rows → BACKGROUND cognitive extraction → commit/graph/embed
  A-->>R: turn-complete + tokens-updated
  R-->>U: final answer + recalled-records + token usage
```

**Read this as the spine of the whole system:** frontend → host → `runTurn` → (recall) → hooks/policy →
LLM↔tools loop → (capture) → background memory consolidation. Every other section is a zoom-in on one of these
boxes.

---

## 14. Key file index

| Subsystem | Anchor files |
|---|---|
| **Agent core** | `packages/core/src/agent/agent.ts` (`runTurn` 1051, `processOneToolCall` 2383, `injectRecallContext` 4785, `captureTurn` 5022) |
| **Tools / policy / hooks** | `tool/registry.ts`, `tool/executors.ts`, `tool/toolSafety.ts`, `exec/execPolicy.ts`, `hooks/hooksStore.ts` |
| **Delegation / workers** | `orchestration/tools.ts` (`handleSpawn` 623), `orchestration/workerTools.ts`, `task/taskStore.ts` |
| **Memory recall** | `brainrouter/src/memory/recall.ts` (`recall` 414), `reranker/index.ts`, `pipeline/neural-spark.ts`, `pipeline/graph-recall.ts` |
| **Memory capture** | `brainrouter/src/memory/capture.ts`, `pipeline/cognitive-extractor.ts`, `llm/cognitive-breaker.ts`, `llm/modelRunner.ts`, `engine.ts` (sweeper 1603) |
| **Memory storage** | `brainrouter/src/memory/store/sqlite.ts`, `store/embedding.ts`, `store/reranker.ts`, `store/relevance-judge.ts`, `llm/llm-semaphore.ts`, `llm/token-bucket.ts` |
| **MCP transport** | `brainrouter/src/transport/mcpServer.ts`, `packages/core/src/mcp/mcpClient.ts`, `mcp/mcpPool.ts` |
| **Desktop** | `brainrouter-desktop/electron/main.ts`, `electron/host.ts`, `electron/hostCore.ts`, `electron/preload.cts`, `src/App.tsx`, `src/lib/agent/useAgentEvents.ts`, `src/settings.tsx` |
| **CLI** | `brainrouter-cli/src/index.ts`, `cli/ink/runChat.tsx`, `cli/repl.ts`, `runtime/federationRegistration.ts`, `cli/commands/*` |
| **Extensibility** | `packages/core/src/extension/{loader,manifest,host,registry,extensionStore}.ts`, `provider/catalog.ts`, `pack/packs.ts`, `workspace/workspaceTrust.ts` |
| **Federation** | `runtime/federationRegistration.ts`, `packages/core/src/util/federationIdentity.ts`, `session/completionInbox.ts` |

---

*Generated from a live read of the codebase on the `release/0.4.15` branch. Diagrams are GitHub-flavored Mermaid —
view in any Mermaid-aware renderer.*

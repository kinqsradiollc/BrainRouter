# BrainRouter Memory Engine — Architecture & Implementation

> The definitive technical reference for BrainRouter's memory system.
> Adapted from TencentDB Agent Memory research, extended far beyond it.
>
> **Last updated:** May 2026

---

## What BrainRouter Is (and Isn't)

| Dimension | BrainRouter | TencentDB Agent Memory | agentmemory |
|---|---|---|---|
| **Scope** | Agentic OS: Skills + Routing + Memory | Memory engine (OpenClaw plugin) | Memory daemon only |
| **Memory types** | 4 (persona, episodic, instruction, **skill_context**) | 3 (persona, episodic, instruction) | 4-tier (Working/Episodic/Semantic/Procedural) |
| **Contradiction handling** | **First-class L1.5 — surfaces to user** | Silently dedup (store/update/merge/skip) | Auto-evict based on decay score |
| **Capture mechanism** | MCP tool-driven (agent calls after each turn) | Hook-driven (agent_end event) | 12 auto-hooks (zero agent effort) |
| **Skill awareness** | ✅ Full — extraction hints per skill, skill_tag on every memory | ❌ None | ❌ None |
| **Knowledge graph** | ⏳ Phase 2 (planned) | ❌ None | ✅ Entity extraction + BFS traversal |
| **Retrieval** | BM25 + Vector + RRF + Cross-Encoder Reranker | BM25 + Vector + RRF | BM25 + Vector + Graph traversal + RRF |
| **Temporal validity** | ⏳ Phase 2 (planned) | ❌ Not modeled | ❌ Not modeled |
| **ACE feedback loop** | ⏳ Phase 2 (planned) | ❌ None | ❌ None |
| **Multi-tenant** | ✅ user_id on all tables, enforced in every query | Partial (sessionKey scoped) | ❌ Single-process |
| **Runtime** | stdio / HTTP — no daemon required | File-based SQLite, OpenClaw-only | iii-engine daemon (WebSocket + REST) |
| **Auto skill generation** | ⏳ Phase 2 — from skill_context patterns | ❌ None | ❌ None (4 manually authored skills) |

---

## The Big Picture: Orthogonal Systems with MCP Tools

The engine is built inside `mcp/src/memory/` and exposed to the agent via MCP tools.

```mermaid
graph TD
    A["Agent Turn Ends"] --> B["MCP Tool: memory_capture_turn"]
    B --> C["Engine.capture()"]
    C --> D["L0: Write raw turn\n(node:sqlite FTS5)"]
    D --> E["Scheduler (N-turn threshold)"]
    E -- "every ~5 turns" --> F["L1 Extractor\n(LLM → 4 types + skill_tag)"]
    F --> G["L1.5 Contradiction Detection\n(new memory vs existing)"]
    G --> H["L1 Deduplication\n(FTS-based: drop near-identical)"]
    H --> I[("node:sqlite + sqlite-vec\nBackground embedding")]
    E -- "every ~10 L1s" --> J["L2 Scene Distiller\n(narrative chapters + heat score)"]
    E -- "every ~50 L1s" --> K["L3 Persona Distiller\n(4-layer cross-session synthesis)"]

    L["Agent Turn Starts"] --> M["MCP Tool: memory_recall"]
    M --> N["Engine.recall()"]
    N --> O["Stage 1: BM25 FTS5 + Vector (Top 15 each)"]
    O --> P["Stage 2: RRF Merge\n70% relevance + 30% decay blend\n+1.2× skill-tag boost"]
    P --> Q["Stage 3: Cross-Encoder Reranker\n(Cohere / Qwen3 / BGE — Top 5)"]
    Q --> R["Inject: prependContext (L1)\n+ appendSystemContext (L2/L3)"]
    R --> S["Agent processes & responds"]
```

---

## Shipped: The Full Memory Stack

### Layer 0 — Raw Conversation Storage

**File:** `mcp/src/memory/capture.ts`  
**Tool:** `memory_capture_turn`

- Every message written to `l0_conversations` with `user_id` isolation
- FTS5 indexed immediately; vector embedding queued as background task
- `activeSkill` tag attached — every turn knows which BrainRouter skill was running
- Cursor-based capture: each message carries a monotonic `timestamp`; duplicate detection via unique `(userId, sessionKey, timestamp, role)` composite
- Never blocks the agent — embedding is always fire-and-forget

### Layer 1 — Extracted Structured Memories

**File:** `mcp/src/memory/pipeline/l1-extractor.ts`  
**Prompt:** `mcp/src/memory/prompts/l1-extraction.ts`

The LLM acts as a **Skill-Aware Memory Extraction Expert**. It processes the last 10 new messages (with 5 older messages as read-only context) and produces:

| Memory Type | What it captures | Half-life |
|---|---|---|
| `persona` | Stable user traits, preferences, identity | 180 days |
| `episodic` | Objective events with timestamps and outcomes | 30 days |
| `instruction` | Long-term rules the user gave the AI | **Never decays** |
| `skill_context` *(BrainRouter-original)* | How *this user* runs *this skill* specifically | 7 days |

**Skill Hints:** The active skill's `memory_hints` (from `SKILL.md` frontmatter) are injected into the extraction prompt, guiding what to look for in that domain.

**Quality gates before calling the LLM:**
- Filters messages shorter than a threshold (noise)
- Filters symbol-only or injection-attempt messages
- Prefers zero memories over bad memories ("Nothingness > Bad memory")

### Layer 1.5 — Contradiction Detection (First-Class)

**File:** `mcp/src/memory/pipeline/l1-contradiction.ts`

This is BrainRouter's most significant advance over TencentDB's dedup model:

| Approach | TencentDB | agentmemory | BrainRouter |
|---|---|---|---|
| When conflict detected | Silent LLM judgment: store/update/merge/skip | Auto-evict lower-priority | Flag in `contradictions` table |
| Agent visibility | Never sees it | Never sees it | **Surfaced during next recall** |
| User agency | None | None | **Explicit ⚠️ warning, user resolves** |

**How it works:**
1. New memory → embed → vector search for top-5 similar existing memories
2. LLM batch judgment: is this a conflict, update, or new?
3. Conflicts stored in `contradictions` table with both record IDs
4. During recall: unresolved contradictions injected as `⚠️ Contradiction:` warnings

### Layer 2 — Scene Narratives

**File:** `mcp/src/memory/pipeline/l2-scene.ts`

- Triggers every `BRAINROUTER_L2_TRIGGER_N` L1 extractions (default: 10)
- LLM reads new L1 batch → decides: update existing scene / create new scene
- Scenes stored with **heat score** (+30 on each distillation, decays each cycle)
- Scene summaries injected as stable `<scene-navigation>` block in `appendSystemContext`
- Stored as rows in `l2_scenes` SQLite table (not files — no filesystem coupling)

### Layer 3 — Persona Synthesis

**File:** `mcp/src/memory/pipeline/l3-distiller.ts`

- Triggers every `BRAINROUTER_L3_TRIGGER_N` L1 extractions (default: 50)
- Reads **all** `persona` + `instruction` L1 memories cross-session for this user
- Synthesizes via LLM with 90s timeout → 4-layer profile:

| Layer | What it synthesizes |
|---|---|
| Base Anchors | Role, tech stack, current projects |
| Interest Graph | Actively worked on vs. passively followed |
| Interaction Protocol | Communication style, preferred response format |
| Cognitive Core | Decision logic, risk tolerance, what drives you |

- Persona injected as stable `<user-persona>` block in `appendSystemContext`
- Auto-trigger from L2: if scene extractor detects major direction shift → L3 runs immediately

---

## The Retrieval Pipeline (3-Stage)

```mermaid
graph TD
    Q["User Query + activeSkill"]

    Q --> BM25["Stage 1 — BM25 Keyword Search\n(Top 15 Candidates)"]
    Q --> Vec["Stage 1 — Vector Semantic Search\n(Top 15 Candidates)"]

    BM25 --> RRF["Stage 2 — RRF Merge: Σ 1/(60+rank)\n(Top 20 Merged)"]
    Vec --> RRF

    RRF --> Blend["Stage 2 — Score Blend\n70% RRF + 30% Half-Life Decay\n+ Skill Tag Boost ×1.2"]

    Blend --> Rerank["Stage 3 — Cross-Encoder Reranker\n(Cohere / Qwen3 / BGE)\nTop 5 injected into context"]

    Rerank --> Out["→ prependContext (L1 dynamic)\n→ appendSystemContext (L2+L3 stable/cached)"]
```

**Why each stage matters:**
- **Keyword** — catches exact terms ("pnpm", "auth service") via FTS5
- **Vector** — catches *meaning* ("package manager" → surfaces pnpm memories)
- **RRF** — high in both = almost certainly relevant
- **Reranker** — reads query AND candidate together; highest precision, runs only on top 20

**Decay scoring formula:**
```typescript
function effectivePriority(memory: L1Record): number {
    if (memory.type === 'instruction' || !memory.halfLifeDays) {
        return memory.priority; // instructions never decay
    }
    const ageDays = (Date.now() - new Date(memory.createdTime).getTime()) / 86_400_000;
    const decayFactor = Math.pow(0.5, ageDays / memory.halfLifeDays);
    return memory.priority * decayFactor;
}

// Blend: 70% RRF relevance + 30% decay-weighted priority
const blendedScore = (rrfScore * 0.7) + (effectivePriority(m) / 100 * 0.3);
```

---

## Context Injection Format

### `prependContext` — User message prefix (dynamic, per-turn)
```xml
<relevant-memories>
  The following memories are relevant to this query. Reference only if helpful:

  - [persona] User always uses pnpm, never npm or yarn. (skill: conventions-skill)
  - [episodic|debugging] User fixed a Next.js hydration bug on 2026-05-10 by disabling SSR for auth.
  - [instruction] User requires all responses to use TypeScript, never plain JavaScript.
  ⚠️ Contradiction: "User prefers REST" conflicts with "User now using gRPC for internal services" — unresolved.
</relevant-memories>
```

### `appendSystemContext` — System prompt suffix (stable, cacheable)
```xml
<user-persona>
  # User Narrative Profile
  > Archetype: A pragmatic full-stack engineer who optimizes for shipping speed over architectural purity.
  ...
</user-persona>

<scene-navigation>
  Skills recently active: debugging-and-error-recovery (3 sessions), spec-driven-development (1 session)
  Scenes: backend-architecture, auth-debugging, devops-pipeline
</scene-navigation>

<memory-tools-guide>
  Use memory_search to retrieve more specific memories.
  Use memory_contradictions to review unresolved conflicts.
  Max 3 memory tool calls per turn.
</memory-tools-guide>
```

---

## Planned: What Outperforms Everything

These are the next innovations that will make BrainRouter's memory system class-leading.

### 2.1 — Skill-Conditioned Knowledge Graph (GraphRAG)

> Our answer to agentmemory's knowledge graph — but skill-aware.

agentmemory does entity extraction and BFS traversal. We will go further:
every graph edge will carry a `skill_tag` attribute — which BrainRouter skill was active when the relationship was established.

```
User --[prefers | skill: conventions-skill]--> TypeScript
Project --[uses | skill: docker-lifecycle]--> Docker
Decision --[resulted-in | skill: debugging]--> Fix
Bug --[was-fixed-by | skill: debugging]--> Solution
```

This allows a query that neither competitor supports:
> *"What architectural decisions did we make during debugging sessions that we might want to revisit?"*

**v1 implementation:** SQLite adjacency tables (`graph_edges` with `source_id`, `target_id`, `relation`, `skill_tag`, `confidence`).  
**v2:** FalkorDB or Neo4j for larger teams.

### 2.2 — Temporal Validity Windows (inspired by Zep/Graphiti)

> The mechanism that makes L1.5 contradictions automatically resolve over time.

Current L1.5 flags conflicts and surfaces a warning. The next step: temporal supersession.

```sql
ALTER TABLE l1_records ADD COLUMN valid_from TEXT;
ALTER TABLE l1_records ADD COLUMN valid_to TEXT;    -- null = currently valid
ALTER TABLE l1_records ADD COLUMN invalid_at TEXT;  -- set when a newer memory supersedes this
ALTER TABLE l1_records ADD COLUMN superseded_by TEXT REFERENCES l1_records(record_id);
```

When a new `instruction` memory contradicts an old one:
- Old memory: `invalid_at = NOW()`, `superseded_by = new_record_id`
- Not deleted — audit trail preserved
- Agent can query: *"what was the rule in March?"* — time-bounded recall

This resolves the **biggest UX friction** in L1.5: contradictions don't disappear because users rarely remember to resolve them. Temporal supersession makes the system self-healing over time.

### 2.3 — ACE Feedback Loop (Citation Tracking)

> The mechanism neither TencentDB nor agentmemory has at all.

Track which recalled memories were actually cited in agent responses. Use this signal to:

1. **Up-rank useful memories** — frequently cited → higher effective priority in decay scoring
2. **Auto-archive noise** — never cited after N recalls → archive flag set, excluded from active pool
3. **Feed skill detection** — if `skill_context` memories for a pattern are consistently cited → proposal threshold drops

```typescript
// New tool: memory_mark_cited
// Called by agent when it uses a specific recalled memory in its response
server.tool("memory_mark_cited", {
    inputSchema: z.object({
        userId: z.string(),
        recordIds: z.array(z.string()), // IDs from the last memory_recall result
    })
});
```

```sql
ALTER TABLE l1_records ADD COLUMN citation_count INTEGER DEFAULT 0;
ALTER TABLE l1_records ADD COLUMN last_cited_at TEXT;
ALTER TABLE l1_records ADD COLUMN never_cited_count INTEGER DEFAULT 0; -- increments on each recall where NOT cited
```

### 2.4 — Autonomous Skill Detection from skill_context Patterns

> `create_skill` and `update_skill` are already shipped. This is the detection layer.

Background scheduler scans `skill_context` memories:

```
Pattern detected across 4 sessions (from skill_context memories):
  You've solved React hydration bugs with a consistent 4-step process.
  Step 1: Disable SSR for the component temporarily
  Step 2: Check browser console for hydration mismatch errors
  Step 3: Trace to server/client rendering boundary
  Step 4: Fix the boundary mismatch

  → Proposed skill: "react-hydration-debugging"
  → Call create_skill to save, or dismiss for 30 days.
```

The detection pipeline:
1. Query `skill_context` memories: group by `sceneName` + semantic clustering
2. Same N-step structure seen 3+ times → candidate pattern
3. Surface proposal via new `memory_skill_proposals` tool
4. On approval: call `create_skill` automatically with the detected workflow
5. On dismiss: suppress same proposal for configurable cooldown

### 2.5 — Model Routing (Cost Optimisation)

> 60–80% reduction in LLM API cost for memory operations.

Different extraction tasks need different model quality:

| Task | Model tier | Rationale |
|---|---|---|
| L1 extraction | Fast/cheap (Haiku, GPT-4o-mini, DeepSeek-V3) | Structured JSON → smaller model sufficient |
| L1.5 contradiction judgment | Fast/cheap | Yes/No classification task |
| L2 scene distillation | Medium (Sonnet, GPT-4o) | Narrative quality matters |
| L3 persona synthesis | Smarter (Sonnet, GPT-4o) | Deep reasoning over long context |

```typescript
// .env configuration
BRAINROUTER_EXTRACTION_MODEL=gpt-4o-mini    // L1, L1.5
BRAINROUTER_SYNTHESIS_MODEL=gpt-4o          // L2, L3
BRAINROUTER_LLM_ENDPOINT=https://api.openai.com/v1/chat/completions
```

### 2.6 — Skill Pre-warming

> Proactive context injection before the agent asks.

Analyse `skill_context` memories for temporal patterns:
- User always opens `spec-driven-development` at the start of new features
- User runs `debugging-and-error-recovery` in the first session of each week

When pattern confidence exceeds threshold → inject that skill's extraction hints + workflow summary into `appendSystemContext` proactively. Zero latency, zero agent effort.

---

## The Storage Layer

**Files:** `mcp/src/memory/store/sqlite.ts` & `embedding.ts`

Uses **`node:sqlite`** (built into Node 22+) + **`sqlite-vec`**. No external database dependencies.

### Key Tables (Current)

| Table | Purpose |
|-------|---------|
| `l0_conversations` | Raw messages, FTS5 indexed, `user_id` scoped |
| `l1_records` | Extracted memories (4 types). Half-life, priority, `skill_tag` |
| `l2_scenes` | Scene narratives with heat scores |
| `l3_persona` | Latest persona profile per user |
| `contradictions` | Conflicting L1 pairs, resolved/unresolved status |
| `skill_extraction_hints` | Cached hints from SKILL.md files |
| `vec_l1` | sqlite-vec virtual table for L1 vector embeddings |

### Planned Additions

| Table | Purpose | Phase |
|-------|---------|-------|
| `graph_nodes` | Entities: User, Technology, Decision, Project, Bug | 2.1 |
| `graph_edges` | Relations with `skill_tag` and `confidence` | 2.1 |
| `l1_records.valid_from / valid_to / invalid_at` | Temporal supersession | 2.2 |
| `l1_records.citation_count / never_cited_count` | ACE feedback signal | 2.3 |
| `skill_proposals` | Auto-detected skill candidates awaiting approval | 2.4 |

### Multi-Tenant Isolation

Every table has a `user_id` column. Every SQL query strictly filters by `WHERE user_id = ?`. The `userId` is passed as a required parameter in every MCP tool call — never inferred or trusted from session state.

---

## The MCP Tools Interface

### Current (Shipped)

| Tool | When called | What it does |
|---|---|---|
| `memory_capture_turn` | After every agent response | Records L0 turn, schedules L1 pipeline |
| `memory_recall` | Before generating a response | 3-stage retrieval + L2/L3 injection |
| `memory_search` | When injected context is insufficient | Explicit semantic search |
| `memory_contradictions` | Proactive check / contradiction warning | Lists or resolves conflicts |
| `memory_register_skill_hints` | When loading a skill | Teaches engine what to extract |
| `memory_resolve_session` | Session start | Resolves stable sessionKey UUID |

### Planned

| Tool | Phase | Purpose |
|---|---|---|
| `memory_mark_cited` | 2.3 | Signal that specific recalled memories were used |
| `memory_skill_proposals` | 2.4 | List/approve/dismiss auto-detected skill patterns |
| `memory_graph_query` | 2.1 | Traverse knowledge graph by entity or relation |
| `memory_export` | 3 | Export full memory snapshot (L1 + L2 + L3) |
| `memory_import` | 3 | Import snapshot on new machine / team member |
| `memory_prune` | Nice-to-have | Manually archive low-relevance memories |
| `memory_stats` | Nice-to-have | Counts, sizes, oldest memory, embedding coverage |

---

## Competitive Advantage Summary

| Capability | TencentDB | agentmemory | **BrainRouter** |
|---|---|---|---|
| Memory types | 3 | 4-tier | 4 + skill_context |
| Contradiction model | Silent dedup | Silent eviction | **Explicit L1.5 + user resolution** |
| Skill awareness | ❌ | ❌ | **Full — per-skill hints + skill_tag** |
| Knowledge graph | ❌ | Entity BFS | **Skill-conditioned graph** *(planned)* |
| Temporal validity | ❌ | ❌ | **valid_from/valid_to** *(planned)* |
| ACE feedback loop | ❌ | ❌ | **Citation tracking → auto-archive** *(planned)* |
| Auto skill generation | ❌ | ❌ | **From skill_context patterns** *(planned)* |
| Retrieval | BM25 + Vec + RRF | BM25 + Vec + Graph | **BM25 + Vec + RRF + Cross-Encoder Reranker** |
| Multi-tenant | Partial | ❌ | **user_id enforced on every query** |
| Runtime dependency | OpenClaw plugin | iii-engine daemon | **None — stdio, zero infrastructure** |
| Extraction language | Chinese (hardcoded) | Configurable | **English, configurable endpoint** |
| Benchmarks | PersonaMem 76% | LongMemEval ~68% | *to be measured — targets: beat both* |

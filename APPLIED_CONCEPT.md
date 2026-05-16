# BrainRouter Memory Engine
### An Evolved Agent Memory System — Built on Reference Code

> **Goal**: Integrate a hierarchical, skill-aware memory system directly into BrainRouter's MCP server — adapting the battle-tested architecture from the reference code (`conceptCode/src/`) and improving it in 5 critical ways for BrainRouter's unique multi-user, MCP-native context.

---

## What the Reference Code Gets Right (Keep These)

| Concept | Reference Location | Why Keep It |
|---------|-------------------|-------------|
| `RuntimeContext` with `userId` + `sessionKey` + `sessionId` | `core/types.ts` | **Multi-tenant from day one** — `userId` already a first-class field |
| Cursor-based atomic L0 capture with per-session checkpoint | `core/hooks/auto-capture.ts` | Prevents duplicate messages — essential correctness |
| 3-type memory taxonomy (persona / episodic / instruction) | `core/record/l1-extractor.ts` | Proven, clean classification |
| LLM-as-extractor with scene segmentation + JSON output | `core/prompts/l1-extraction.ts` | Most reliable extraction pattern |
| Background deferred embedding (non-blocking) | `core/hooks/auto-capture.ts` (Path A) | Non-negotiable for UX |
| Hybrid FTS5 BM25 + vector cosine with RRF | `core/hooks/auto-recall.ts` | Best recall quality for the cost |
| Recall timeout guard via `Promise.race()` | `core/hooks/auto-recall.ts` | Never block the agent |
| `node:sqlite` built-in (Node 22+) — no extra dependency | `core/store/sqlite.ts` | Zero install friction, aligns with existing stack |
| `supportsDeferredEmbedding` capability flag | `core/store/sqlite.ts` | Clean abstraction for sync/async embedding paths |
| `IMemoryStore` interface for backend flexibility | `core/store/types.ts` | Allows SQLite locally, cloud VDB remotely |
| Stable `appendSystemContext` + dynamic `prependContext` split | `core/hooks/auto-recall.ts` | Optimizes prompt caching across all providers |
| Host-neutral `LLMRunner` interface | `core/types.ts` | Decouples from any specific LLM SDK |

---

## Architecture Adjustments for BrainRouter Reality

### ✅ Adjustment 1: Source Path — `mcp/src/memory/`, not `src/memory/`

The reference code lives in `conceptCode/src/`. In BrainRouter, **all server code lives in `mcp/src/`**. The memory engine must be built at:
```
mcp/src/memory/
```

### ✅ Adjustment 2: Node.js Built-in SQLite — `node:sqlite` (Node 22+)

The reference code uses `node:sqlite` (Node.js built-in, available in Node 22+), **not** `better-sqlite3`. This is the correct choice for BrainRouter — it requires no additional npm dependency.

```typescript
// From conceptCode/src/core/store/sqlite.ts
const require = createRequire(import.meta.url);
function requireNodeSqlite(): typeof import("node:sqlite") {
  return require("node:sqlite") as typeof import("node:sqlite");
}
```

> [!IMPORTANT]
> Verify that BrainRouter's CI/CD environment runs Node 22+. If not, `node:sqlite` won't be available. Add a `engines` field to `package.json`: `"node": ">=22.0.0"`.

### ✅ Adjustment 3: Multi-Tenant Identity via `RuntimeContext`

The reference code already models multi-tenancy through `RuntimeContext.userId`. In BrainRouter's MCP context, `userId` will be passed in as a required tool input parameter — since there's no session layer managing identity automatically.

```typescript
// RuntimeContext (from conceptCode/src/core/types.ts) — adapt for MCP tool calls:
interface BrainRouterMemoryContext {
  userId: string;      // REQUIRED — caller must provide, enables tenant isolation
  sessionKey: string;  // Stable identifier for a conversation channel
  sessionId?: string;  // Optional sub-session grouping
}
```

All SQL queries will be scoped with `WHERE user_id = ?` to enforce tenant isolation.

### ✅ Adjustment 4: Host-Neutral `LLMRunner` — Configurable OpenAI-Compatible Endpoint

The reference code defines a clean `LLMRunner` interface (in `core/types.ts`) that abstracts away any specific LLM SDK. BrainRouter's implementation will use **environment variables** to configure an OpenAI-compatible endpoint:

```typescript
// BrainRouter's StandaloneLLMRunner implementation
const runner: LLMRunner = {
  async run({ prompt, systemPrompt, timeoutMs = 120_000 }) {
    const res = await fetch(process.env.BRAINROUTER_LLM_ENDPOINT ?? "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.BRAINROUTER_LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.BRAINROUTER_LLM_MODEL ?? "gpt-4o-mini",
        messages: [
          ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json() as { choices: [{ message: { content: string } }] };
    return data.choices[0].message.content;
  }
};
```

### ✅ Adjustment 5: English-First Extraction Prompt + 4th Memory Type

The reference code's L1 extraction prompt is written in Chinese (`你是专业的...`). BrainRouter's version will:
1. Be written entirely in English
2. Add a **4th memory type**: `skill_context` (unique to BrainRouter's skill system)
3. Include `skill_tag` in the output JSON — which active BrainRouter skill produced this memory

---

## The 4th Memory Type: `skill_context`

Our biggest addition over the reference code — exclusive to BrainRouter:

| Type | What it captures | Example |
|------|-----------------|---------| 
| `persona` | Stable user traits, preferences | "User prefers TypeScript over JavaScript" |
| `episodic` | Objective events with timestamps | "User deployed auth service on 2026-05-10" |
| `instruction` | Long-term AI behavior rules | "Always use pnpm, never npm" |
| **`skill_context`** *(new)* | Observations about how the user runs skills | "User always skips spec phase for hotfixes" |

`skill_context` memories feed directly into the **skill discovery router** — over time, the system learns which skills *this specific user* tends to invoke in which order, and can pre-warm context.

---

## The Full Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                  BRAINROUTER MCP SERVER (mcp/src/)               │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    MEMORY ENGINE                            │  │
│  │              (mcp/src/memory/)                              │  │
│  │                                                             │  │
│  │  Capture Path (after agent turn)                            │  │
│  │  ─────────────────────────────                              │  │
│  │  L0: Raw capture                                            │  │
│  │      → Atomic cursor-based write (per user_id+session)      │  │
│  │      → node:sqlite FTS5 (immediate) + vec0 (background)    │  │
│  │      ↓ [every N turns]                                      │  │
│  │  L1: LLM extraction (English prompt, 4 types)               │  │
│  │      → persona / episodic / instruction / skill_context     │  │
│  │      → skill_tag from active BrainRouter skill              │  │
│  │      ↓                                                      │  │
│  │  L1.5: Contradiction Detection (first-class layer)          │  │
│  │      ↓                                                      │  │
│  │  L1 Write: node:sqlite + sqlite-vec (bg embedding)          │  │
│  │      ↓ [every N memories]                                   │  │
│  │  L2: Scene Narratives (Markdown files, heat-scored)         │  │
│  │      ↓                                                      │  │
│  │  L3: Persona (4-layer deep scan → persona.md)               │  │
│  │                                                             │  │
│  │  Recall Path (before agent turn)                            │  │
│  │  ────────────────────────────                               │  │
│  │  Hybrid: FTS5 BM25 + vec0 cosine → RRF                     │  │
│  │  + Skill-context boost (if active_skill tag matches)        │  │
│  │  + Decay-weighted scoring (half-life by type)               │  │
│  │  → inject L1 (dynamic, prependContext)                      │  │
│  │  → inject L2+L3 (stable, appendSystemContext, cacheable)    │  │
│  │                                                             │  │
│  │  Multi-Tenant Isolation                                     │  │
│  │  ─────────────────────                                      │  │
│  │  All queries scoped: WHERE user_id = ?                      │  │
│  │  userId passed in MCP tool inputs                           │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              SKILL SYSTEM (existing)                        │  │
│  │  Each skill declares extraction_hints (memory_hints)        │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## SQLite Schema (Adapted from Reference Code)

> Based on `conceptCode/src/core/store/sqlite.ts` — key addition is `user_id` on every table.

```sql
-- L0: Raw conversation messages (multi-tenant)
CREATE TABLE l0_conversations (
    record_id   TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,        -- ← MULTI-TENANT KEY (added vs. reference)
    session_key TEXT NOT NULL,
    session_id  TEXT DEFAULT '',
    role        TEXT NOT NULL DEFAULT '',
    message_text TEXT NOT NULL,
    recorded_at TEXT DEFAULT '',
    timestamp   INTEGER DEFAULT 0,
    skill_tag   TEXT DEFAULT ''       -- ← active BrainRouter skill at capture time
);
CREATE INDEX idx_l0_user_session ON l0_conversations(user_id, session_key);
CREATE INDEX idx_l0_recorded ON l0_conversations(recorded_at);
CREATE VIRTUAL TABLE l0_fts USING fts5(
    message_text,
    message_text_original UNINDEXED,
    record_id UNINDEXED,
    user_id UNINDEXED,
    session_key UNINDEXED,
    role UNINDEXED,
    recorded_at UNINDEXED,
    timestamp UNINDEXED
);

-- L1: Extracted structured memories (multi-tenant)
CREATE TABLE l1_records (
    record_id    TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,       -- ← MULTI-TENANT KEY (added vs. reference)
    session_key  TEXT DEFAULT '',
    session_id   TEXT DEFAULT '',
    content      TEXT NOT NULL,
    type         TEXT DEFAULT '',     -- persona | episodic | instruction | skill_context
    priority     INTEGER DEFAULT 50,
    scene_name   TEXT DEFAULT '',
    skill_tag    TEXT DEFAULT '',     -- ← which BrainRouter skill produced this memory
    half_life_days INTEGER,           -- null = never decay (instruction type)
    superseded_by TEXT,               -- ID of newer memory replacing this one
    timestamp_str TEXT DEFAULT '',
    timestamp_start TEXT DEFAULT '',
    timestamp_end TEXT DEFAULT '',
    created_time TEXT DEFAULT '',
    updated_time TEXT DEFAULT '',
    metadata_json TEXT DEFAULT '{}'
);
CREATE INDEX idx_l1_user_type ON l1_records(user_id, type);
CREATE INDEX idx_l1_user_session ON l1_records(user_id, session_key);
CREATE INDEX idx_l1_user_updated ON l1_records(user_id, updated_time);
CREATE VIRTUAL TABLE l1_fts USING fts5(
    content,
    content_original UNINDEXED,
    record_id UNINDEXED,
    user_id UNINDEXED,
    type UNINDEXED,
    priority UNINDEXED,
    scene_name UNINDEXED,
    skill_tag UNINDEXED,
    session_key UNINDEXED,
    timestamp_str UNINDEXED
);

-- vec0 virtual tables (created only when dimensions > 0)
-- CREATE VIRTUAL TABLE l1_vec USING vec0(
--   record_id TEXT PRIMARY KEY,
--   embedding float[1536] distance_metric=cosine,
--   updated_time TEXT DEFAULT ''
-- );

-- Contradiction log (new vs. reference code)
CREATE TABLE contradictions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    memory_a_id  TEXT REFERENCES l1_records(record_id),
    memory_b_id  TEXT REFERENCES l1_records(record_id),
    detected_at  TEXT NOT NULL,
    resolved     INTEGER DEFAULT 0,
    resolution   TEXT
);

-- Skill extraction hints (new vs. reference code)
CREATE TABLE skill_extraction_hints (
    skill_name TEXT PRIMARY KEY,
    hints_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

## L1 Extraction Prompt (English + Skill-Aware)

> Adapted from the Chinese prompt in `conceptCode/src/core/prompts/l1-extraction.ts`.

```
SYSTEM PROMPT:
You are a Skill-Aware Memory Extraction Expert for a software engineering AI assistant.

Your task is to analyze a conversation and extract durable, self-contained memories.
The agent was running the BrainRouter skill: {{ active_skill.name }}
Skill-specific extraction hints: {{ active_skill.extraction_hints }}

### Scene Segmentation
Determine if the topic has changed since the previous scene.
If it has, assign a new scene name: "AI helping [user role] with [goal activity]" (unique, max 50 words).
If not, inherit the previous scene name.

### Memory Types (extract ONLY these 4)

1. **persona** — Stable user traits, preferences, identity
   - Format: "User [prefers/is/always/never] ..."
   - Priority: 80-100 (core identity) / 50-70 (preferences) / skip if <50

2. **episodic** — Objective events, decisions, results with timestamps
   - Format: "User [did X] at [time] resulting in [Y]"
   - Include activity_start_time/activity_end_time in metadata when determinable (ISO 8601)
   - Priority: 80-100 (major decisions) / 60-79 (significant events) / skip if <60

3. **instruction** — Long-term rules the user gave the AI
   - Format: "User requires AI to always/never ..."
   - Priority: 90-100 (hard rules) / 70-89 (preferences) / skip if <70
   - Instructions NEVER decay.

4. **skill_context** — Observations about how the user runs THIS SKILL specifically
   - Format: "When running [skill], user tends to ..."
   - Only extract if a genuine behavioral pattern is visible, not a one-off.

### Quality Rules
- Nothingness > Bad memory. Prefer empty over wrong.
- Memory must stand alone without the conversation.
- Merge causally-linked facts into one memory.
- Do not extract AI outputs — only user behavior and statements.
- Filter out: tool calls, one-time requests, casual greetings.

### Output (JSON array only, no markdown wrapper)
[
  {
    "scene_name": "current or inherited scene name",
    "message_ids": ["id1", "id2"],
    "memories": [
      {
        "type": "persona|episodic|instruction|skill_context",
        "content": "self-contained memory statement",
        "priority": 85,
        "skill_tag": "{{ active_skill.name }}",
        "source_message_ids": ["id1"],
        "metadata": {}
      }
    ]
  }
]
```

---

## MCP Tool Definitions

```typescript
// 1. Capture a completed conversation turn
server.tool("memory_capture_turn", {
    description: "Record a completed conversation turn for memory processing. Call after every agent response.",
    inputSchema: z.object({
        userId: z.string(),          // REQUIRED — enables multi-tenant isolation
        sessionKey: z.string(),
        sessionId: z.string().optional(),
        messages: z.array(z.object({
            role: z.enum(["user", "assistant", "tool"]),
            content: z.string(),
            timestamp: z.number(),
        })),
        userText: z.string(),
        activeSkill: z.string().optional(),  // e.g. "debugging-and-error-recovery"
    })
});

// 2. Recall memories before a turn
server.tool("memory_recall", {
    description: "Retrieve relevant memories, persona, and scene context before generating a response.",
    inputSchema: z.object({
        userId: z.string(),          // REQUIRED — scopes recall to this user only
        query: z.string(),
        sessionKey: z.string(),
        activeSkill: z.string().optional(),
        strategy: z.enum(["keyword", "embedding", "hybrid"]).default("keyword"),
    })
});

// 3. Active semantic search
server.tool("memory_search", {
    description: "Search structured L1 memories. Use when injected context is insufficient.",
    inputSchema: z.object({
        userId: z.string(),          // REQUIRED
        query: z.string(),
        type: z.enum(["persona", "episodic", "instruction", "skill_context"]).optional(),
        skillTag: z.string().optional(),
        limit: z.number().default(5),
    })
});

// 4. View unresolved contradictions
server.tool("memory_contradictions", {
    description: "List unresolved memory contradictions for a user.",
    inputSchema: z.object({
        userId: z.string(),          // REQUIRED
        resolved: z.boolean().default(false),
    })
});

// 5. Register skill extraction hints
server.tool("memory_register_skill_hints", {
    description: "Register extraction hints for a BrainRouter skill.",
    inputSchema: z.object({
        skillName: z.string(),
        hints: z.array(z.string()),
    })
});
```

---

## Recall Injection Format

When `memory_recall` is called, it returns two context blocks (matching the reference code's stable/dynamic split):

### `prependContext` — User message prefix (dynamic, per-turn, never cached)
```xml
<relevant-memories>
  The following memories are relevant to this query. Reference only if helpful:

  - [persona] User always uses pnpm, never npm or yarn. (skill: conventions-skill)
  - [episodic|debugging] User fixed a Next.js hydration bug on 2026-05-10 by disabling SSR for the auth component.
  - [instruction] User requires all responses to use TypeScript, never JavaScript.
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
  Scene files: backend-architecture.md, auth-debugging.md
</scene-navigation>

<memory-tools-guide>
  Use memory_search to retrieve more specific memories.
  Use memory_contradictions to review unresolved conflicts.
  Max 3 memory tool calls per turn.
</memory-tools-guide>
```

---

## Decay-Weighted Recall Scoring

```typescript
function effectivePriority(memory: L1Record): number {
    if (memory.type === 'instruction' || !memory.halfLifeDays) {
        return memory.priority; // instructions never decay
    }
    const ageDays = (Date.now() - new Date(memory.createdTime).getTime()) / 86_400_000;
    const decayFactor = Math.pow(0.5, ageDays / memory.halfLifeDays);
    return memory.priority * decayFactor;
}

// Blend with RRF score during recall
const blendedScore = (rrfScore * 0.7) + (effectivePriority(m) / 100 * 0.3);
```

| Type | Half-life |
|------|-----------|
| `instruction` | Never decays |
| `persona` | 180 days |
| `episodic` | 30 days |
| `skill_context` | 7 days |

---

## Files To Create In BrainRouter

```
mcp/src/
├── memory/
│   ├── engine.ts              ← Facade: initializes store, exposes capture/recall
│   ├── capture.ts             ← L0 + L1 + L1.5 capture pipeline
│   ├── recall.ts              ← Hybrid recall with decay scoring
│   ├── types.ts               ← BrainRouter-specific memory types (extends core/types.ts concepts)
│   ├── store/
│   │   ├── sqlite.ts          ← node:sqlite store (adapted from conceptCode/src/core/store/sqlite.ts)
│   │   └── embedding.ts       ← Embedding service wrapper (configurable endpoint)
│   ├── pipeline/
│   │   ├── l1-extractor.ts    ← LLM extraction (adapted from conceptCode/src/core/record/l1-extractor.ts)
│   │   ├── l1-contradiction.ts ← Contradiction detection (new — not in reference code)
│   │   ├── l2-scene.ts        ← Scene narrative builder (Phase 4)
│   │   └── l3-persona.ts      ← Persona generator (Phase 4)
│   ├── prompts/
│   │   ├── l1-extraction.ts   ← English prompt (adapted + extended from reference)
│   │   ├── l1-contradiction.ts ← Contradiction classifier prompt (new)
│   │   └── l3-persona.ts      ← Persona synthesis prompt (Phase 4)
│   └── scheduler.ts           ← N-turn trigger manager
└── tools/
    ├── memory_capture_turn.ts ← MCP tool definition
    ├── memory_recall.ts        ← MCP tool definition
    ├── memory_search.ts        ← MCP tool definition
    ├── memory_contradictions.ts ← MCP tool definition
    └── memory_register_skill_hints.ts ← MCP tool definition

skills/memory/
└── agent-memory/
    └── SKILL.md               ← Skill teaching agents how to use the memory tools
```

---

## Phased Build Plan

### Phase 1 — Core Engine MVP (~3-4 days)
- [ ] `mcp/src/memory/store/sqlite.ts` — node:sqlite schema + CRUD (`user_id` on all tables)
- [ ] `mcp/src/memory/pipeline/l1-extractor.ts` — LLM extraction with English prompt
- [ ] `mcp/src/memory/capture.ts` — L0 atomic capture + L1 trigger logic
- [ ] `mcp/src/memory/recall.ts` — FTS5 BM25 keyword recall + decay scoring
- [ ] `mcp/src/memory/engine.ts` — Facade class
- [ ] `mcp/src/tools/memory_capture_turn.ts` + `memory_recall.ts` — MCP tools
- [ ] Wire tools into `mcp/src/index.ts`
- [ ] Unit tests for store + decay scoring

### Phase 2 — Intelligence Layer (~2-3 days)
- [ ] `mcp/src/memory/store/embedding.ts` — configurable embedding service
- [ ] sqlite-vec integration for vector storage
- [ ] Background deferred embedding (non-blocking Path A)
- [ ] Hybrid RRF recall (FTS5 + vector cosine)
- [ ] `mcp/src/memory/pipeline/l1-contradiction.ts` — contradiction detection
- [ ] `memory_search.ts` + `memory_contradictions.ts` MCP tools

### Phase 3 — Skill Integration (~1-2 days)
- [ ] Read `memory_hints` from skill SKILL.md frontmatter
- [ ] `skill_extraction_hints` DB table + `memory_register_skill_hints` MCP tool
- [ ] Inject `active_skill` context into L1 extraction prompt
- [ ] Skill-context boost in recall scoring
- [ ] Add `memory_hints` to 3-5 key skills

### Phase 4 — Narrative Layers (High Value, Optional)
- [ ] L2 Scene Markdown files with heat scoring
- [ ] L3 Persona generation (4-layer deep scan → persona.md)
- [ ] Scene navigation injection
- [ ] `skill_context` type routing to skill discovery
- [ ] Cross-session memory graph (linked_to relationships)

---

## Competitive Advantage vs. Reference Code

| Capability | Reference Code | BrainRouter Memory Engine |
|------------|---------------|--------------------------|
| Memory types | 3 (persona, episodic, instruction) | 4 (+skill_context) |
| Priority model | Static at extraction | Decays by type half-life |
| Contradiction handling | Side-effect of dedup | First-class L1.5 layer |
| Skill awareness | None | Full — per-skill extraction hints |
| Multi-tenant | `userId` in RuntimeContext | `user_id` column on all tables + enforced in every query |
| Extraction language | Chinese (hardcoded) | English, configurable |
| MCP-native | No (OpenClaw plugin) | Yes — BrainRouter MCP tool |
| Contradiction visibility | Agent sees nothing | Surfaces in recall context |
| Prompt cache optimization | ✅ (stable/dynamic split) | ✅ (same pattern) |
| Local-first | ✅ node:sqlite | ✅ node:sqlite |

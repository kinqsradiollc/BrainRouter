# 🧠 BrainRouter — Presentation

> **Tagline:** *Give your AI coding agent a Brain, a Map, and a Memory.*

---

## Slide 1 — The Problem

### AI Agents Today Are Goldfish

Every conversation, every session — the agent starts from zero.

- You explain your stack **again**
- You re-state your preferences **again**
- You re-teach your conventions **again**
- The agent scans the entire repo **every time**

**The result:** Slow, noisy, expensive, and frustrating sessions.

> "We constantly re-explain the same SOPs, project background, tool conventions, and output formats to the Agent. Such information should not require repetition."
> — TencentDB Agent Memory (Tencent Research)

---

## Slide 2 — The Inspiration: TencentDB Agent Memory

### Standing on Giant Shoulders

BrainRouter's memory architecture is directly inspired by **[TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory)** — a research project by Tencent that proved layered memory systems dramatically improve agent performance.

**Their results (measured over continuous long-horizon sessions):**

| Benchmark | Without Memory | With Memory | Improvement |
|---|---|---|---|
| WideSearch (task success) | 33% | **50%** | +51.52% |
| WideSearch (token usage) | 221M tokens | **85M tokens** | −61.38% |
| SWE-bench (code tasks) | 58.4% | **64.2%** | +9.93% |
| PersonaMem (persona accuracy) | 48% | **76%** | +59% |

**Their core insight:** Memory should NOT be flat vector storage. It must be a **semantic pyramid** — from raw conversation up to distilled persona.

### What They Built vs. What We Built

| Dimension | TencentDB Agent Memory | BrainRouter |
|---|---|---|
| **Delivery format** | OpenClaw plugin + Hermes Docker | **MCP Server** (universal) |
| **Target agents** | OpenClaw, Hermes | Cursor, VS Code, Claude, Codex, Antigravity — **any MCP-compatible tool** |
| **Memory architecture** | L0 → L3 pipeline | **L0 → L3 + L1.5 Contradiction Detection** |
| **Memory types** | 3 (persona, episodic, instruction) | **4 (+skill_context)** |
| **Skill system** | None | **Full skill/persona/reference registry** |
| **Extraction language** | Chinese (hardcoded) | **English, configurable** |
| **Priority/decay model** | Static at extraction | **Decay by half-life per type** |
| **Roadmap: Skill generation** | ❌ Not yet built | **✅ Shipped — full skill authoring system** |
| **Roadmap: Portable memory** | ❌ Not yet built | **✅ Multi-tenant by design** |
| **Roadmap: Visual debugging** | ❌ Not yet built | **⚠️ Planned** |

> **Key difference in scope:** TencentDB is an agent *plugin* tightly coupled to specific agents. BrainRouter is an **MCP server** — a universal brain that works with *any* agent tool without modifying the agent itself.

---

## Slide 3 — What is BrainRouter?

### Three Systems in One

```
┌──────────────────────────────────────────────────────┐
│                    BRAINROUTER                        │
│                                                       │
│  🧠 BRAIN         📚 MAP            💾 MEMORY         │
│  Skills           AGENT.md          Memory Engine     │
│  Personas         Context Router    L0 → L3 Pipeline  │
│  References       Skill Matching    Contradiction Mgr │
│                                                       │
│         Delivered as an MCP Server                    │
│    stdio (local) or HTTP (remote/Docker)              │
└──────────────────────────────────────────────────────┘
```

**One sentence:** BrainRouter is an MCP server that gives any AI coding agent a structured brain (skills + personas), a navigation map (AGENT.md routing), and persistent memory (hierarchical SQLite engine).

---

## Slide 4 — Architecture: The Dual Registry

### Global + Local — Automatic Override

```
BrainRouter/          ← Global Registry (universal, battle-tested)
  skills/
    agent/            ← debugging, planning, spec-driven, etc.
    codebase/         ← code-review, conventions, simplification
    design/           ← soft-skill, minimalist-ui, gpt-taste
    devops/           ← docker, ci-cd, git-workflow
    memory/           ← agent-memory
    ...

YourProject/          ← Local Registry (project-specific)
  skills/             ← shadows global skills by name
  agents/             ← project personas
  references/         ← project reference docs
  docs/               ← structured markdown source-of-truth
  AGENT.md            ← your routing map
```

**Rule:** Local skills with the same name as a global skill **automatically override** the global version for that project — no config needed.

---

## Slide 5 — Architecture: The AGENT.md Router

### The Navigation Hub

`AGENT.md` is the agent's context firewall. Instead of scanning the entire repository, the agent reads `AGENT.md` and is routed to exactly the right skill, persona, or doc.

**How it works — 7-step execution model:**

```
1. RESOLVE SESSION  →  mcp_brainrouter_resolve_session()
        ↓
2. RECALL CONTEXT  →  mcp_brainrouter_memory_recall()
        ↓
3. DETECT INTENT   →  map request to scenario in AGENT.md
        ↓
4. SELECT SKILL    →  identify skill name from the scenario map
        ↓
5. EXECUTE         →  mcp_brainrouter_get_skill() → follow workflow
        ↓
6. RECORD OUTCOME  →  mcp_brainrouter_memory_capture_turn()
        ↓
7. ITERATE         →  return to router if scenario changes
```

**Scenario routing examples from BrainRouter's own AGENT.md:**

| Scenario | Skill / Persona Loaded |
|---|---|
| MCP Server Development | `api-skill` + `conventions-skill` |
| Memory Engine Development | `spec-driven-development` |
| Skill & Content Authoring | `skill-authoring` + `doc-management-skill` |
| Debugging | `debugging-and-error-recovery` |
| DevOps / Docker | `docker-lifecycle-engineering` |
| Code Review | `code-reviewer` persona |
| PR / PR Review | `code-review-and-quality` |

---

## Slide 6 — Architecture: The Three Composable Layers

### Skills · Personas · Commands

```
┌────────────────────────────────────┐
│  COMMANDS   /review /debug /ship   │  ← The WHEN (user entry points)
├────────────────────────────────────┤
│  PERSONAS   code-reviewer          │  ← The WHO (role + perspective)
│             security-auditor       │
│             test-engineer          │
├────────────────────────────────────┤
│  SKILLS     spec-driven-development│  ← The HOW (workflows + checklists)
│             debugging-and-recovery │
│             incremental-impl...    │
│             skill-authoring        │
│             ... 40+ skills         │
└────────────────────────────────────┘
```

**Composition rule:** Personas do NOT invoke other personas. A persona may invoke global skills via `get_skill`.

**Currently shipped skills (sample):**

- `spec-driven-development` — Write specs before any code
- `debugging-and-error-recovery` — Systematic Reproduce → Localize → Fix → Guard
- `incremental-implementation` — Break large changes into reviewable PRs
- `code-review-and-quality` — Multi-axis PR review
- `skill-authoring` — Canonical format for writing new skills
- `docker-lifecycle-engineering` — Production-grade containerization
- `agent-memory` — Teaches agents to use the 5 memory tools correctly
- `concept-diagrams` — SVG diagram generation
- `soft-skill` / `gpt-taste` / `minimalist-ui` — Premium UI design systems

---

## Slide 7 — The Memory Engine: Overview

### A 4-Tier Semantic Pyramid

Directly adapted from TencentDB's proven architecture, evolved for BrainRouter's MCP-native context:

```
                    ┌──────────┐
                    │  L3      │  ← Persona Profile (stable, deep)
                    │ Persona  │
                   /└──────────┘\
                  / ┌──────────┐ \
                 /  │  L2      │  \
                /   │  Scene   │   \
               /    │ Narratives│   \
              /     └──────────┘    \
             /    ┌─────────────┐    \
            /     │    L1.5     │     \
           /      │Contradiction│      \
          /       │  Detection  │       \
         /        └─────────────┘        \
        /       ┌───────────────┐         \
       /        │      L1       │          \
      /         │ Semantic Ext. │           \
     /          │ (4 types)     │            \
    /           └───────────────┘             \
   /──────────────────────────────────────────\
   │                   L0                      │
   │           Raw Conversation Capture        │
   └────────────────────────────────────────────┘
```

---

## Slide 8 — Memory Engine: L0 — Raw Capture

### Every Word, Preserved

**What it does:** Atomically records every conversation turn to `node:sqlite` with FTS5 full-text indexing.

**Key design decisions:**
- **Cursor-based capture** — a per-session checkpoint prevents any message from being captured twice, even with concurrent sessions
- **Multi-tenant from day one** — every record has a `user_id` column; all queries are scoped `WHERE user_id = ?`
- **Skill tagging** — the active BrainRouter skill at capture time is stored as `skill_tag`, enabling skill-aware recall later
- **Background vector embedding** — FTS5 indexing is immediate (milliseconds); vector embedding runs in the background so the agent is never blocked

```
MCP Tool: memory_capture_turn
  → receives: userId, sessionKey, messages[], activeSkill
  → writes: l0_conversations (SQLite FTS5)
  → queues: background vector embedding
  → notifies: scheduler (trigger L1 when N turns reached)
```

---

## Slide 9 — Memory Engine: L1 — Semantic Extraction

### From Raw Text to Structured Knowledge

**What it does:** Every N turns, an LLM analyzes the conversation and extracts only *durable, self-contained memories*.

**The 4 memory types (BrainRouter extends TencentDB's 3):**

| Type | What it captures | Decay half-life |
|---|---|---|
| `persona` | Stable user traits and preferences | 180 days |
| `episodic` | Objective events with timestamps | 30 days |
| `instruction` | Long-term rules the user gave the AI | **Never decays** |
| **`skill_context`** *(BrainRouter-only)* | How the user runs specific skills | 7 days |

**The `skill_context` type is our biggest addition.** It lets the system learn patterns like: *"When running debugging-and-error-recovery, this user always skips the reproduction step for hotfixes."* This feeds directly into the skill discovery router.

**Quality gate before LLM call:**
```
Filter out: tool calls, one-time requests, casual greetings,
            symbol-only messages, prompt injection attempts
Rule: Nothingness > Bad memory. Prefer empty over wrong.
```

**Skill-aware extraction prompt:**
```
System: You are a Skill-Aware Memory Extraction Expert.
        Active skill: {{ active_skill.name }}
        Skill hints: {{ active_skill.extraction_hints }}
        ...extract only these 4 types...
```

Each skill can declare `memory_hints` in its `SKILL.md` frontmatter — these are injected into the L1 prompt to guide extraction for that skill's domain.

---

## Slide 10 — Memory Engine: L1.5 — Contradiction Detection

### First-Class Conflict Resolution

**This layer does not exist in TencentDB.** It is a BrainRouter original.

**The problem it solves:** Without contradiction detection, a user's old instruction ("always use npm") will coexist alongside a newer one ("always use pnpm"). The agent doesn't know which to follow — silent confusion.

**How it works:**
1. After L1 extraction, each new memory is checked against existing similar memories (via FTS5 BM25 search)
2. Candidates are evaluated: does the new memory *conflict* with an existing one?
3. Conflicts are written to the `contradictions` table
4. During **recall**, unresolved contradictions are surfaced as warnings in the agent's context

**What the agent sees during recall:**
```xml
<relevant-memories>
  - [instruction] User requires all responses in TypeScript.
  ⚠️ Contradiction: "Always use npm" conflicts with "Always use pnpm"
     — unresolved. Ask user to clarify.
</relevant-memories>
```

This turns a silent bug into an **explicit, resolvable signal**.

---

## Slide 11 — Memory Engine: L2 — Scene Narratives

### Memories → Stories

**What it does:** Clusters related L1 memories into cohesive Markdown narrative blocks representing distinct domains of the user's work.

**The LLM decision tree:**
```
Phase 0: Count existing scenes. If ≥ maxScenes → MUST merge first.
Phase 1: Which domain do these memories belong to?
Phase 2: UPDATE existing scene / MERGE two scenes / CREATE new?
          → Default is UPDATE. CREATE is a last resort.
Phase 3: Write the narrative (a story, not a list).
```

**Scene file format (Markdown with heat metadata):**
```markdown
---
summary: User's backend architecture journey, TypeScript, MCP work
heat: 7   ← how many times this scene has been updated
updated: 2026-05-17T...
---

## Core Narrative
User has been migrating from REST to MCP-native tooling...

## Evolution
- [2026-05-10]: Shifted from Express to stdio MCP transport
```

**Heat scoring** lets the recall engine prioritize active, frequently-updated scenes over stale ones.

---

## Slide 12 — Memory Engine: L3 — Persona Synthesis

### The Deepest Layer

**What it does:** Every N new memories, performs a 4-layer deep psychological + technical profile synthesis.

| Layer | Target | Value to Agent |
|---|---|---|
| 🟢 Layer 1: Base Anchors | Demographics, current state, facts | Context awareness |
| 🔵 Layer 2: Interest Graph | Active vs. passive interests | Relevant recommendations |
| 🟡 Layer 3: Interaction Protocol | Communication style, workflows | How to speak, how to deliver |
| 🔴 Layer 4: Cognitive Core | Decision logic, deep drives | Co-pilot for architectural decisions |

**Output:** A synthesized persona summary injected as stable `appendSystemContext` — cached at the prompt level, never re-computed on every turn.

**Cross-layer signal:** If the L2 scene extractor detects a major value shift, it emits a signal:
```
[PERSONA_UPDATE_REQUEST]
reason: User shifted from "TypeScript purist" to "pragmatic polyglot"
[/PERSONA_UPDATE_REQUEST]
```
The engine parses this and schedules an immediate L3 re-run.

---

## Slide 13 — Memory Engine: Recall

### Reading the Right Memory at the Right Time

**Before every agent turn**, `memory_recall` assembles three context layers:

```
Agent turn starts
      ↓
memory_recall(userId, query, sessionKey, activeSkill)
      ↓
┌─────────────────────────────────────────────────┐
│  L1 Search: Hybrid FTS5 BM25 + vec0 cosine      │
│  → Reciprocal Rank Fusion (RRF) merge           │
│  → Decay scoring: blended = RRF*0.7 + decay*0.3 │
│  → Skill-context boost if active_skill matches  │
│  → Output: prependContext (dynamic, per-turn)    │
├─────────────────────────────────────────────────┤
│  L2 Scene summaries → appendSystemContext        │
│  L3 Persona profile → appendSystemContext        │
│  (stable, benefits from prompt caching)          │
├─────────────────────────────────────────────────┤
│  L1.5 Contradiction warnings                     │
│  (unresolved conflicts surfaced to agent)        │
└─────────────────────────────────────────────────┘
      ↓
Agent generates response with full context
```

**Decay-weighted scoring:**

| Type | Half-life |
|---|---|
| `instruction` | Never decays |
| `persona` | 180 days |
| `episodic` | 30 days |
| `skill_context` | 7 days |

**Timeout protection:** The entire recall is wrapped in `Promise.race()` with a 5-second timeout. If recall is slow, the agent proceeds without memory injection rather than blocking the user.

---

## Slide 14 — The MCP Tools Interface

### 5 Tools, Fully Exposed

| Tool | Direction | When Called |
|---|---|---|
| `memory_capture_turn` | Agent → BrainRouter | After every response |
| `memory_recall` | Agent → BrainRouter | Before every response |
| `memory_search` | Agent → BrainRouter | Explicit deep search |
| `memory_contradictions` | Agent → BrainRouter | Conflict resolution |
| `memory_register_skill_hints` | Agent → BrainRouter | When loading a new skill |

**Plus the skill/persona/doc tools:**

| Tool | Purpose |
|---|---|
| `list_skills` | List all skills (global + local merged) |
| `get_skill` | Fetch skill section (overview, workflow, checklist…) |
| `search_skills` | Fuzzy search across all skills |
| `get_persona` | Fetch a persona definition |
| `get_reference` | Fetch a reference document |
| `list_docs` | List project docs |
| `get_doc` | Read a project doc or section |
| `create_skill` | Scaffold a new skill |
| `update_skill` | Update an existing skill section |

---

## Slide 15 — Transport: How It Works in Practice

### No Server URL Required (stdio Mode)

```
Your AI Tool  ──spawn──▶  node dist/index.js --root /your/project
              ◀──stdio──▶  (MCP JSON-RPC over pipes)
```

- The AI tool **spawns the BrainRouter process** when it starts
- Communication over **stdin/stdout pipes** — no port, no URL, no `npm run dev`
- The tool manages the entire process lifecycle

**Also supports HTTP mode** (for remote/shared/Docker deployments):
```bash
node dist/index.js --root /path/to/project --http --port 3747
```

**Works with:**
- ⚡ Cursor
- 🐙 VS Code / GitHub Copilot
- 🟣 Claude Desktop
- ✨ Antigravity (Google Gemini)
- 🤖 OpenAI Codex
- Any MCP-compatible tool

---

## Slide 16 — Setup in 4 Steps

```bash
# Step 1 — Clone & Build
git clone https://github.com/kinqsradiollc/BrainRouter.git
cd BrainRouter/mcp && npm install && npm run build

# Step 2 — Generate config for your project
npm run setup:mcp -- /path/to/your/project
# Writes ready-to-paste configs into <your-project>/.brainrouter/

# Step 3 — Paste the mcpServers block into your AI tool's config
# (Cursor / VS Code / Claude Desktop / Codex / Antigravity)

# Step 4 — Restart your AI tool
# It will spawn BrainRouter automatically on next launch
```

**Then, in your project, add `AGENT.md`:**
```markdown
# Agent Context Router
You are connected to the BrainRouter MCP Server.
Do NOT guess how to perform tasks. Use your MCP tools first.

1. Recall Memory: call memory_recall before every response
2. Find Skills: use list_skills or search_skills
3. Execute: use get_skill to load the workflow
4. Capture: call memory_capture_turn after every response
```

Start a session with: *"Read AGENT.md and let's get to work."*

---

## Slide 17 — What We've Shipped vs. TencentDB Roadmap

### Their Roadmap vs. Our Reality

| TencentDB Roadmap Item | Their Status | BrainRouter Status |
|---|---|---|
| Long-term memory (L0→L3) | ✅ Done | ✅ Done |
| Short-term context compression (Mermaid canvas) | ✅ Done | ⚠️ Planned (different approach) |
| Local SQLite backend | ✅ Done | ✅ Done (node:sqlite, zero deps) |
| Agent framework integration | ✅ OpenClaw + Hermes | ✅ Universal MCP (all tools) |
| **Portable memory (cross-agent)** | ❌ Not yet built | ✅ Multi-tenant architecture done |
| **Automatic Skill generation** | ❌ Not yet built | ✅ Full skill system + authoring |
| **Visual debugging dashboard** | ❌ Not yet built | ⚠️ Planned |
| Contradiction detection | ❌ Not in their system | ✅ BrainRouter original (L1.5) |
| Skill-aware memory extraction | ❌ Not in their system | ✅ BrainRouter original |
| Decay-weighted scoring | ❌ Static priority | ✅ BrainRouter original |

---

## Slide 18 — Key Technical Differentiators

### What Makes BrainRouter Unique

**1. MCP-Native, Not Agent-Specific**
TencentDB requires you to install their plugin into OpenClaw or run their Docker Hermes. BrainRouter works with *any* MCP-compatible AI tool — no agent modification needed.

**2. Skill System as Memory Context**
The `skill_context` memory type and `memory_register_skill_hints` tool create a feedback loop: the more you use BrainRouter, the smarter it gets at pre-loading the right context for your specific patterns.

**3. Contradiction Detection as a First-Class Layer (L1.5)**
TencentDB deduplicates as a side-effect. BrainRouter explicitly detects, stores, surfaces, and resolves semantic conflicts — turning silent bugs into explicit agent warnings.

**4. Decay-Weighted Recall**
Different memory types fade at different rates. Instructions (rules) never decay. Episodic memories (events) fade in 30 days. This ensures the agent prioritizes the most relevant, current context.

**5. Dual Registry with Automatic Override**
Global skills (universal patterns) + local skills (project-specific) merge automatically. A local `debugging-and-error-recovery` skill for your React Native app will override the global one — without any config change.

**6. Zero Runtime Dependencies for Storage**
Uses `node:sqlite` (built into Node.js 22+) — no `better-sqlite3`, no external database, no Docker required for the memory engine.

---

## Slide 19 — Storage Architecture

### SQLite Schema (Simplified)

```sql
-- L0: Every conversation turn
l0_conversations (record_id, user_id, session_key, role,
                  message_text, skill_tag, timestamp)
  + FTS5 virtual table for full-text search

-- L1: Extracted structured memories
l1_records (record_id, user_id, session_key, content,
            type, priority, scene_name, skill_tag,
            half_life_days, superseded_by, ...)
  + FTS5 virtual table
  + vec0 virtual table for vector similarity

-- L1.5: Contradiction tracking
contradictions (id, user_id, memory_a_id, memory_b_id,
                detected_at, resolved, resolution)

-- Skill hints cache
skill_extraction_hints (skill_name, hints_json, updated_at)
```

**Multi-tenant enforcement:** Every table has `user_id`. Every query filters `WHERE user_id = ?`. No cross-user data leakage is architecturally possible.

---

## Slide 20 — What's Next

### Roadmap

**Near-term (in progress):**
- [ ] L2 Scene Narratives — full Markdown file generation with heat scoring
- [ ] L3 Persona Synthesis — 4-layer deep scan → persona summary
- [ ] Hybrid RRF recall — FTS5 BM25 + sqlite-vec cosine fusion
- [ ] Visual memory dashboard — inspect layers, contradictions, scene blocks

**Medium-term:**
- [ ] Cross-session memory graph — linked memories across projects
- [ ] `skill_context` → skill pre-warming — auto-load a skill when the pattern matches
- [ ] Portable memory export/import — move memories between projects and tools

**Long-term:**
- [ ] Automatic skill generation from patterns — watch how you solve problems and generate new skills
- [ ] Team memory (shared tenant) — organizational knowledge graph

---

## Summary

### BrainRouter in One Paragraph

BrainRouter is a **Model Context Protocol (MCP) server** that gives any AI coding agent three things it desperately needs: a **skill registry** (40+ battle-tested workflow blueprints), a **context router** (AGENT.md that eliminates blind repo scanning), and a **hierarchical memory engine** (L0→L3 SQLite pipeline, inspired by TencentDB's research). Unlike TencentDB Agent Memory — which is a plugin for specific agent frameworks — BrainRouter is framework-agnostic, works through the standard MCP protocol, and extends the architecture with three original contributions: L1.5 Contradiction Detection, skill-aware memory extraction via `skill_context`, and decay-weighted recall scoring. The result is an agent that remembers your preferences, learns your patterns, flags its own contradictions, and never makes you repeat yourself.

---

*Built for High-Density Engineering.*
*Reference: [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory) — Tencent Research*

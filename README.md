# 🧠 BrainRouter

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%233178c6.svg)](https://www.typescriptlang.org/)
[![Model: MCP Server](https://img.shields.io/badge/Protocol-MCP-orange.svg)](https://modelcontextprotocol.io/)

> **Biologically-Inspired Dual-Process Memory Network and Multi-Agent Orchestration Router**

BrainRouter is a Model Context Protocol (MCP) server and routing layer that equips LLM agents with a multi-layered, biologically-modeled memory network. Designed to emulate human cognitive recall, it prevents context-window saturation, eliminates catastrophic forgetting, and handles real-time knowledge graph propagation, skill-priming, and automated conflict reconciliation.

---

## 🎨 System Overview

Human memory doesn't dump everything into a single context window. It filters, consolidates, decays, and reinforces information dynamically. BrainRouter brings these exact mechanisms to LLM agents:

```mermaid
graph TD
    User([User Prompt]) --> Query[User Query]
    
    subgraph Recall ["Recall Pipeline (System 1 & System 2)"]
        Query --> FTS[Keyword Search: FTS5 BM25]
        Query --> Vec[Vector Search: Cosine Similarity]
        Query --> Path[File-path Heuristic Matches]
        
        FTS --> RRF{Reciprocal Rank Fusion}
        Vec --> RRF
        Path --> RRF
        
        RRF --> Blend[Effective Priority Blend<br/>Decay & Citation Boost]
        Blend --> Rerank[System 2 Reranker]
        Rerank --> GraphExp[2-Hop Graph RAG Expansion]
        GraphExp --> Context[Relevant Memories injected as Context]
    end

    Context --> Agent[LLM Agent Execution]
    Agent --> Response([Agent Response])
    Response --> ACE[ACE Citation Audit<br/>Boost Cited / Prune Unused]
    
    subgraph Consolidation ["Memory Consolidation"]
        Dialogue[Interaction Dialogue] --> Sensory[SensoryStream Buffer]
        Sensory --> CogExtract[Cognitive Extractor Pipeline]
        CogExtract --> Cognitive[(CognitiveRecord DB)]
        Cognitive --> Focus[ContextualFocus Scenes]
        Cognitive --> Identity[CoreIdentity Profile]
        Cognitive --> GraphBuilder[Knowledge Graph Builder]
    end

    ACE --> Consolidation
```

---

## 🚀 Key Features

*   **⚡ Hierarchical Memory Stack**: Emulates sensory buffer (`SensoryStream`), semantic/episodic storage (`CognitiveRecord`), active session focus (`ContextualFocus` scenes), and long-term user profile instructions (`CoreIdentity`).
*   **🔄 ACE (Agent Citation & Evaluation) Loop**: Synaptic reinforcement and pruning. Recalled memories used by the agent get priority boosts (Long-Term Potentiation); neglected ones are archived automatically (Synaptic Pruning).
*   **📉 Forgetting Curve & Half-Life Decay**: Integrates an Ebbinghaus forgetting curve into the retrieval blend, ensuring stale memories decay unless regularly reinforced.
*   **🔗 Graph RAG (2-Hop BFS)**: Extracts entities and relations from memories, building an association graph to pull in adjacent details during query execution.
*   **🔥 Skill Pre-warming**: Automatically spikes active skill potential on trigger keyword detection and injects critical skill context.
*   **⚠️ Contradiction Resolution**: Detects conflicting information and determines if it represents a temporal update (superseding the old fact) or a genuine conflict (flagged for review).
*   **🖥️ Terminal Agent CLI (`brainrouter`)**: Memory-aware coding agent — slash commands, hookify rules, LLM-driven `/compact`, multi-agent orchestration, and durable workflow artifacts. See [Brainrouter CLI](#-brainrouter-cli) below.
*   **🪝 Hookify Markdown Rules**: Drop a `.md` file into `.brainrouter/hooks/` to install warn/block guardrails on tool calls — no code, just YAML frontmatter and a regex.
*   **🗂️ Filesystem Memory Consolidation**: Phase-2-style artifacts (`MEMORY.md`, `user.md`, `feedback.md`, `project.md`, `reference.md`, `raw_memories.md`) written under `.brainrouter/memories/` so the cognitive store has a human-readable view.
*   **🔎 Filtered & Freshness-Boosted Recall**: `memory_recall` / `memory_search` accept `filters` (types, scenes, time window, minPriority, skillTag); ranking adds a freshness boost so brand-new captures surface immediately.
*   **🛰️ Batched Multi-Agent Fan-Out**: `spawn_agent` + `wait_agent` + `route_agent` for parallel children in one tool call. Five built-in roles (`explorer / architect / reviewer / worker / verifier`) chosen heuristically from the prompt's leading verb. Large child outputs auto-offload to a working-memory canvas.
*   **🌐 Web Chat & HTTP Endpoint**: Drive the agent from a browser at [`/chat`](web/app/chat), or call the MCP server's `/api/chat-completions` route from any HTTP client and inherit the full memory stack.
*   **🛡️ Memory Governance & Engineering**: `memory_governance_*` (audit, import/export, prune), `memory_engineering_*` (manual edits), and `memory_explain_recall` for ranking introspection — production-grade controls over the cognitive store.

---

## 🤖 Multi-Agent Roles

`spawn_agent(role, prompt, …)` and `route_agent(task)` dispatch to five bounded, memory-aware roles. Each opens with a mandatory memory-first phase (`memory_search` → `memory_graph_query` → file history) before doing any work.

| Role | Access | Purpose |
| :--- | :--- | :--- |
| **explorer** | read-only | Codebase investigation, surface key files & symbols, no edits |
| **architect** | read-only | Design alternatives & tradeoffs grounded in prior decisions |
| **reviewer** | read-only | Severity-ordered findings; cites prior reviews to avoid re-flagging |
| **worker** | read/write | Implementation; must read before editing; auto-marks task complete |
| **verifier** | shell | Run tests, type-checks, lint; reports blocker states |

Outputs over ~6k chars are written to a **working-memory canvas** (`memory_working_*`) so the parent agent can inspect them on demand without burning context.

---

## 🖥️ Brainrouter CLI

The repo ships a terminal agent at [`brainrouter/`](brainrouter/) — a memory-native coding agent built around the BrainRouter cognitive stack as a first-class tool.

```bash
cd brainrouter
npm install && npm run build
node dist/index.js                          # interactive REPL
node dist/index.js run "summarize src/"     # one-shot non-interactive
```

**Slash commands (highlights):**

| Category | Commands |
| :--- | :--- |
| Session | `/new`, `/fork`, `/rename`, `/resume`, `/sessions`, `/side`, `/btw`, `/clear`, `/compact`, `/quit` |
| Style & UI | `/theme`, `/title`, `/personality`, `/raw`, `/statusline`, `/vim`, `/keymap` |
| Memory | `/memory`, `/recall`, `/briefing`, `/scenes`, `/forget`, `/handover`, `/explain`, `/memories` |
| Workflow | `/spec`, `/feature-dev`, `/review`, `/implement-plan`, `/workflows`, `/approve` |
| Orchestration | `/spawn`, `/wait`, `/agents`, `/agent`, `/route_agent`, `/roles` |
| Guardrails | `/permissions`, `/hooks`, `/hookify`, `/yolo`, `/ps`, `/stop` |
| Ops | `/status`, `/doctor`, `/diagnostics`, `/debug-config`, `/tokens`, `/watch`, `/rollout`, `/feedback` |

**Compaction (`/compact`)** asks the LLM for a structured summary (Goals / Decisions / Files touched / Open work / Last user request) and replaces the verbose chat history with a single tagged system block so long conversations don't blow the context window.

**Hookify (`/hookify`)** loads markdown rules from `.brainrouter/hooks/*.md`. Example:

```markdown
---
name: block-rm-rf
enabled: true
event: bash
pattern: rm\s+-rf
action: block
---

⚠️ Dangerous rm command blocked. Verify the path is correct.
```

**Memory consolidation (`/memories consolidate`)** runs Phase 2 over the MCP recall surface and writes per-type markdown files under `.brainrouter/memories/`. The same operation is exposed as the MCP tool `memory_consolidate` so any MCP-compatible client can produce the artifacts.

See [`walkthrough.md`](walkthrough.md) for the latest implementation pass and [`task.md`](task.md) for the scope.

---

## 🧰 MCP Tools (Inventory)

The MCP server exposes the following tool families. All are usable from any MCP host (the BrainRouter CLI, Claude Desktop, Cursor, or any other MCP client) and from the HTTP `/api/chat-completions` endpoint.

| Family | Tools |
| :--- | :--- |
| **Recall** | `memory_search`, `memory_recall`, `memory_graph_query`, `memory_resolve_session`, `memory_explain_recall` |
| **Capture & Curate** | `memory_capture_turn`, `memory_consolidate`, `memory_mark_cited`, `memory_register_skill_hints` |
| **Conflict** | `memory_contradictions` (detect / list / resolve) |
| **Working Canvas** | `memory_working_*` (offload, fetch, clear) |
| **Governance** | `memory_governance_*` (audit, import/export, prune) |
| **Engineering** | `memory_engineering_*` (manual edits) |
| **Hooks** | `memory_hooks_*` (automation rules) |
| **Orchestration** | `spawn_agent`, `list_agents`, `wait_agent`, `read_agent_transcript`, `route_agent` |
| **Skills & Personas** | `list_skills`, `get_skill`, `search_skills`, `create_skill`, `update_skill`, `get_persona`, `get_reference`, `list_template_docs`, `get_template_doc` |

---

## 📁 Repository Structure

```filepath
BrainRouter/
├── mcp/                      # Model Context Protocol Server
│   ├── src/
│   │   ├── memory/           # Core Memory Engine
│   │   │   ├── store/        # SQLite database & vector/rerank adapters
│   │   │   ├── pipeline/     # Extraction, scene, and graph pipelines
│   │   │   ├── working/      # Session-level context stores
│   │   │   ├── capture.ts    # Ingestion SensoryStream -> CognitiveRecord
│   │   │   └── recall.ts     # Multi-stage hybrid search & blending
│   │   ├── tools/
│   │   │   ├── memory_*.ts         # search / recall / capture / mark_cited
│   │   │   ├── memory_consolidate.ts # NEW — Phase 2 filesystem artifacts
│   │   │   └── memory-*.ts          # engineering / governance / hooks / working
│   │   └── index.ts          # MCP Server definition and registration
│   ├── package.json
│   └── tsconfig.json
├── brainrouter/              # Terminal Agent CLI (memory-native coding agent)
│   └── src/
│       ├── agent.ts                # Tool-calling loop, hookify integration, compaction
│       ├── repl.ts                 # 60+ slash commands, @mentions, statusline, vim mode
│       ├── compactor.ts            # LLM-driven /compact summarizer
│       ├── hookifyStore.ts         # Markdown-rule guardrails (.brainrouter/hooks/*.md)
│       ├── memoryConsolidation.ts  # Phase 2 filesystem artifacts on the client side
│       ├── orchestrator*.ts        # Multi-agent: spawn_agent, wait_agent, roles
│       ├── workflowArtifacts.ts    # spec.md / tasks.md / walkthrough.md scaffolding
│       ├── cliState.ts             # Per-session bucket helpers (sessions/<key>/…)
│       ├── goalStore.ts            # Per-session sticky goal
│       ├── taskStore.ts            # Per-session durable plan
│       ├── sessionStore.ts         # Per-session transcript.jsonl + legacy fallback
│       └── ...                     # mcp client, sandbox, tracing, etc.
│
│   Personal CLI state lives in the user-global home (NOT inside the project):
│   ~/.brainrouter/
│   ├── memory.db                   # MCP cognitive store (long-term)
│   └── workspaces/<name>-<hash8>/  # One bucket per workspace
│       ├── cli/
│       │   ├── preferences.json    # theme, statusline, vim mode, personality
│       │   ├── hooks.json          # shell lifecycle hooks
│       │   ├── sessions.json       # child-agent orchestration index
│       │   ├── feedback.jsonl      # /feedback entries
│       │   ├── current-workflow.json
│       │   └── sessions/           # ─── ONE FOLDER PER CHAT SESSION ───
│       │       └── <encodedKey>/
│       │           ├── transcript.jsonl
│       │           ├── goal.json
│       │           └── tasks.json
│       ├── hooks/                  # Hookify markdown rules (*.md)
│       └── memories/               # Phase 2 filesystem consolidation
│
│   Override the home location with BRAINROUTER_HOME=/custom/path.
│
│   The ONLY files brainrouter writes inside the workspace are workflow
│   artifacts — committable per-project documentation:
│   <workspace>/.brainrouter/workflows/<slug>/
│       ├── spec.md         # what + why + boundaries
│       ├── tasks.md        # ordered breakdown
│       ├── walkthrough.md  # post-implementation summary
│       └── meta.json
├── packages/                 # Monorepo Packages
│   ├── types/                # Core Shared Types
│   ├── sdk/                  # BrainRouter Client SDK
│   └── hooks/                # React Hooks for Web Dashboard
├── dashboard/                # Web UI dashboard
├── skills/                   # Universal skill library (agent, codebase, lifecycle, …)
├── openSrc/                  # Vendored reference material for research
├── AGENT.md                  # Dev manual for AI coding agents working in this repo
├── BRAINROUTER.md            # Deep Concepts & Math specifications
├── PRESENTATION.md           # Slide Deck Overview
├── task.md / walkthrough.md  # Latest implementation pass scope + handover notes
└── README.md                 # Project Landing Page
```

---

## 🛠️ Getting Started

### 1. Installation
Clone the repository and install dependencies in the root:

```bash
# Clone & install root
git clone https://github.com/kinqsradiollc/BrainRouter.git
# Or navigate to local workspace
cd BrainRouter
npm install
npm run build
```

### 2. Configuration
Create a `.env` file in the `mcp/` directory (see [`.env.example`](file:///Users/anhdang/Documents/Github/BrainRouter/mcp/.env.example) for reference):

```env
# LLM Endpoint & Models
BRAINROUTER_LLM_ENDPOINT="https://api.openai.com/v1/chat/completions"
BRAINROUTER_LLM_API_KEY="your-api-key"
BRAINROUTER_LLM_MODEL="gpt-4o-mini"

# Embedding & Reranking (Optional but recommended)
BRAINROUTER_EMBEDDING_MODEL="text-embedding-3-small"
BRAINROUTER_RERANKER_ENDPOINT="https://api.cohere.com/v1/rerank"
BRAINROUTER_RERANKER_API_KEY="your-cohere-key"

# Database Configuration
BRAINROUTER_MEMORY_DB="./memory.db"
```

### 3. Registering the MCP Server
Add the server configuration to your MCP host clients (e.g. Cursor, Claude Desktop):

```json
{
  "mcpServers": {
    "brainrouter": {
      "command": "node",
      "args": ["/Users/anhdang/Documents/Github/BrainRouter/mcp/dist/index.js"],
      "env": {
        "BRAINROUTER_LLM_ENDPOINT": "https://api.openai.com/v1/chat/completions",
        "BRAINROUTER_LLM_API_KEY": "your-openai-key",
        "BRAINROUTER_LLM_MODEL": "gpt-4o-mini",
        "BRAINROUTER_MEMORY_DB": "/Users/anhdang/Documents/Github/BrainRouter/mcp/memory.db"
      }
    }
  }
}
```

---

## 🧪 Documentation Suite

To dive deeper into the technical mechanics, mathematical routing functions, and visual presentations of BrainRouter:

1.  **[BRAINROUTER.md (Concept Specs)](BRAINROUTER.md)**: Mathematical decay formulas, cognitive memory layer explanations, graph expansion mechanics, conflict resolution loops, and the CLI architecture (agent loop, compaction, hookify).
2.  **[PRESENTATION.md (Slide Deck)](PRESENTATION.md)**: An executive slide-deck overview explaining the business problem, biological inspiration, architecture, the terminal CLI, and the developer roadmap.
3.  **[AGENT.md (Agent System Guidelines)](AGENT.md)**: Guidelines for AI coding agents *building* this repo — skills mapping, workflow phases, openSrc reference habit.
4.  **[ROADMAP.md (Future Milestones)](ROADMAP.md)**: Development phases, vector database expansions, and visual dashboard milestones.
5.  **[walkthrough.md (Latest implementation pass)](walkthrough.md)**: Files touched, tests added, and follow-ups for the most recent implementation pass.

---

## 📄 License
This project is licensed under the MIT License - see the [LICENSE](file:///Users/anhdang/Documents/Github/BrainRouter/LICENSE) file for details.

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

The repo ships a terminal agent at [`brainrouter/`](brainrouter/) — a memory-native coding agent that uses the BrainRouter cognitive stack as a first-class tool. Type `/help` in the REPL for the full slash-command reference. See [BRAINROUTER.md](BRAINROUTER.md) for compaction, hookify rules, and memory consolidation details.

---

## 🛠️ Getting Started

### 1. Install

```bash
git clone https://github.com/kinqsradiollc/BrainRouter.git
cd BrainRouter
npm install
npm run build
```

### 2. Configure

Create `mcp/.env` (template lives at [`mcp/.env.example`](mcp/.env.example)):

```env
BRAINROUTER_LLM_ENDPOINT="https://api.openai.com/v1/chat/completions"
BRAINROUTER_LLM_API_KEY="your-api-key"
BRAINROUTER_LLM_MODEL="gpt-4o-mini"

# Optional: embedding + reranker
BRAINROUTER_EMBEDDING_MODEL="text-embedding-3-small"
BRAINROUTER_RERANKER_ENDPOINT="https://api.cohere.com/v1/rerank"
BRAINROUTER_RERANKER_API_KEY="your-cohere-key"

# Memory store path (relative is fine; defaults inside mcp/)
BRAINROUTER_MEMORY_DB="./memory.db"
```

### 3. Run the CLI

The CLI auto-spawns the MCP server in stdio mode — no separate process needed.

```bash
npm run cli                          # interactive REPL (from repo root)
# or
node brainrouter/dist/index.js run "summarize src/"   # one-shot non-interactive
```

### 4. Run the Web Chat

```bash
# Terminal A — start the MCP HTTP server
cd mcp
npm run start:http                   # listens on http://localhost:3747

# Terminal B — start the Next.js dashboard
cd web
npm run dev                          # http://localhost:3000
```

Open `http://localhost:3000/chat` in a browser to talk to the agent through the same memory stack the CLI uses.

### 5. (Optional) Register the MCP with another host

To connect the MCP to an external MCP host (e.g. Cursor), add it to the host's config:

```json
{
  "mcpServers": {
    "brainrouter": {
      "command": "node",
      "args": ["/absolute/path/to/BrainRouter/mcp/dist/index.js"],
      "env": {
        "BRAINROUTER_LLM_ENDPOINT": "https://api.openai.com/v1/chat/completions",
        "BRAINROUTER_LLM_API_KEY": "your-openai-key",
        "BRAINROUTER_LLM_MODEL": "gpt-4o-mini",
        "BRAINROUTER_MEMORY_DB": "./memory.db"
      }
    }
  }
}
```

---

## 📚 Documentation

- [BRAINROUTER.md](BRAINROUTER.md) — concept specs, decay formulas, recall pipeline, CLI architecture
- [PRESENTATION.md](PRESENTATION.md) — slide-deck overview
- [AGENT.md](AGENT.md) — guidelines for AI coding agents working in this repo
- [ROADMAP.md](ROADMAP.md) — milestones and future direction

---

## 📄 License

MIT — see [LICENSE](LICENSE).

# 🧠 BrainRouter vs. agentmemory: Conceptual & Feature Comparison

This document provides a comprehensive conceptual, architectural, and feature-level comparison between **BrainRouter** and **agentmemory** (specifically the `@agentmemory/agentmemory` library). Both systems draw inspiration from biological cognitive frameworks to solve LLM agent memory persistence, but they diverge significantly in design patterns, mathematical modeling, and execution philosophies.

---

## 🏛️ 1. Core Architecture & Memory Philosophies

At a high level, both systems address the problem of agent amnesia (where AI agents forget critical context between sessions) by implementing layered memory tiers rather than treating memory as a flat vector database. However, their primary design focus differs:

*   **BrainRouter**: Implemented as a **Dual-Process Metacognitive Memory Network**. It focuses on modeling the agent's internal state machine, tracking active workflow scopes through **Contextual Focus Scenes**, dynamically pre-warming skills, and maintaining a permanent, non-fragmented **Core Identity**. It is designed to run as a high-concurrency, multi-tenant off-heap SQLite-based memory engine.
*   **agentmemory**: Implemented as a **Passive Tool-Use Logging & Consolidation Engine** built on the `iii-engine` event/actor runtime. It focuses heavily on **implicit developer activity capture** (using shell/editor hooks to record session history) and mirroring/syncing with local files (like `MEMORY.md` or `CLAUDE.md`).

---

## 📂 2. Memory Tier Structure

Both architectures organize memory hierarchically to represent different timescales and levels of abstraction. The table below maps their equivalent tiers:

| Tier | BrainRouter Layer | agentmemory Tier | Structural & Behavioral Comparison |
| :--- | :--- | :--- | :--- |
| **Short-Term Buffer** | **SensoryStream** | **Working Memory** | **SensoryStream** records raw conversation turns but prunes them aggressively post-extraction to prevent context pollution. agentmemory's **Working Memory** stores raw tool execution inputs/outputs and keeps them accessible for session-replay. |
| **Episodic & Semantic Store** | **CognitiveRecord** | **Episodic & Semantic Memory** | **CognitiveRecord** categorizes facts (e.g., `architecture_decision`, `codebase_fact`, `instruction`) and assigns priority. agentmemory splits this into **Episodic** (what happened in a session) and **Semantic** (distilled facts & patterns). |
| **Active Task Context** | **ContextualFocus** | *None (Implicit only)* | **BrainRouter** groups relevant records into dynamic **Scenes** with active heat scores and drift detection to track shifts in the user's focus. agentmemory relies entirely on global search recall and has no explicit active scene manager. |
| **Permanent / Identity** | **CoreIdentity** | **Procedural Memory** | **CoreIdentity** compiles a synthesized profile (user styles, hard rules) that is prepended directly to system prompts to avoid vector-search fragmentation. agentmemory uses **Procedural Memory** to store workflows and decision patterns retrieved dynamically via search. |

---

## 🔍 3. Retrieval Pipeline Analysis

The retrieval strategies of the two systems showcase different mathematical approaches to fusion and context selection:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      BrainRouter: Dual-Process                         │
│                                                                        │
│  [Query] ──► System 1: Fast Heuristics (FTS5 + Vector + Open Files)    │
│                 │                                                      │
│                 └──► Reciprocal Rank Fusion (RRF)                      │
│                         │                                              │
│             System 2: Metacognitive Blending & Reranking              │
│                 │                                                      │
│                 ├──► Time-Decay Priority Blend (70/30)                 │
│                 ├──► Intent Affinity Boost (e.g., Bug Fix -> 1.3x)     │
│                 ├──► Stage 3 Cross-Encoder Reranking                   │
│                 └──► 2-Hop Knowledge Graph BFS Expansion               │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                     agentmemory: Triple-Stream RRF                     │
│                                                                        │
│  [Query] ──► BM25 Search (Weight: 0.4)                                  │
│         ├──► Cosine Vector Similarity (Weight: 0.6)                     │
│         └──► Knowledge Graph Entity Search (Weight: 0.3)                │
│                 │                                                      │
│                 └──► Weighted Reciprocal Rank Fusion (RRF, k=60)       │
│                         │                                              │
│                         └──► Session Diversification (Max 3/session)    │
└────────────────────────────────────────────────────────────────────────┘
```

### BrainRouter (System 1 & System 2)
BrainRouter utilizes a split-cognitive architecture:
1.  **System 1 (Fast Heuristics)**: Executes parallel lookups across SQLite **FTS5 BM25** (lexical), **dense vector embeddings** (semantic), and **filepath matching** (heuristics based on files currently open in the IDE). Candidates are merged using standard Reciprocal Rank Fusion (RRF).
2.  **System 2 (Deliberate Reranking & Expansion)**: Refines the candidate pool using:
    *   **Priority Blending**: 70% RRF score mixed with 30% decayed priority.
    *   **Intent Affinity**: Boosts category scores depending on query intent (e.g., queries matching developer errors boost `bug_finding` and `instruction` records by `1.3x`).
    *   **Stage 3 Reranker**: Performs deep semantic re-scoring on the top 20 candidate pool using a dedicated API-driven Cross-Encoder service (supporting Cohere's `/v1/rerank` or local vLLM endpoints like `BAAI/bge-reranker-v2-m3`).
    *   **Graph Expansion**: Appends related contexts using a 2-hop Breadth-First Search (BFS) over the Knowledge Graph.

### agentmemory (Triple-Stream RRF & In-Process Rerank)
agentmemory executes single-stage weighted Reciprocal Rank Fusion followed by optional on-device reranking:
1.  **Lexical, Semantic, and Relational Search**: Fuses three search channels:
    *   **BM25 Stream**: Keyword index search.
    *   **Vector Stream**: Dense vector cosine similarity.
    *   **Graph Stream**: Knowledge graph lookup matching query words to extracted entity nodes.
2.  **Weighted Fusion (RRF)**: Fuses the streams via a weighted RRF formula:
    $$\text{Score}_{\text{RRF}} = w_{\text{BM}} \left( \frac{1}{60 + \text{Rank}_{\text{BM}}} \right) + w_{\text{Vec}} \left( \frac{1}{60 + \text{Rank}_{\text{Vec}}} \right) + w_{\text{Graph}} \left( \frac{1}{60 + \text{Rank}_{\text{Graph}}} \right)$$
    with stream weights: $w_{\text{BM}} \approx 0.31$ (0.4/1.3), $w_{\text{Vec}} \approx 0.46$ (0.6/1.3), $w_{\text{Graph}} \approx 0.23$ (0.3/1.3).
3.  **In-Process Stage 3 Rerank**: If `RERANK_ENABLED` is true, it reranks the top 20 fused results entirely on-device using a local quantized cross-encoder model (`Xenova/ms-marco-MiniLM-L-6-v2`) executed via `@xenova/transformers`.
4.  **Session Diversification**: Restricts retrieval to a maximum of 3 records per historical session.

---

## 🧬 4. Biological Mechanics & Mathematical Formulations

Both engines emulate biological cognitive phenomena, but they express these dynamics through different mathematical functions.

### Ebbinghaus Forgetting Curve (Decay)
*   **BrainRouter**: Tailors exponential decay half-lives ($\tau$) to the specific category of memory:
    $$P_{\text{decayed}}(t) = P_{\text{original}} \times 2^{-\frac{t}{\tau}}$$
    *   `instruction`: $\infty$ (never decays).
    *   `architecture_decision` / `security_policy`: 180 days.
    *   `codebase_fact`: 60 days.
    *   `task_state`: 14 days.
    *   `skill_context`: 7 days.
*   **agentmemory**: Uses a continuous Ebbinghaus curve coupled with automatic TTL (Time-To-Live) evictions and importance thresholds, but does not enforce strict category-specific half-life variables.

### Long-Term Potentiation (LTP) & Pruning
*   **BrainRouter**: Implements the **ACE (Agent Citation & Evaluation) Loop**. 
    *   *Synaptic Strengthening*: If the agent cites a recalled record, its priority gets boosted, offsetting time-decay:
        $$P_{\text{effective}} = P_{\text{decayed}} \times (1 + \min(N_{\text{citations}} \times 0.05, 0.30))$$
    *   *Synaptic Pruning*: If a record is surfaced in query results but the agent ignores/does not cite it, `neverCitedCount` increments. If:
        $$N_{\text{never\_cited}} \geq 10$$
        the memory is pruned (moved to the archive tables) to maintain a high-signal index.
*   **agentmemory**: Relies on a passive feedback mechanism. When memories are retrieved, their internal access count increases, delaying decay. Pruning occurs via conflict/contradiction resolution: if an incoming memory contradicts an existing one, the old record is automatically superseded and archived.

### Spreading Activation & Pre-warming
*   **BrainRouter**: 
    *   **Skill Pre-warming**: Detects workspace skill keywords. When triggered, the skill's *memetic potential* spikes ($+1.0$, capped at $4.0$) and decays with a 10-minute half-life:
        $$H_{\text{decayed}} = H_{\text{old}} \times e^{-\lambda t}, \quad \lambda = \frac{\ln(2)}{10}$$
        If $H \geq 0.3$, the skill's guidelines are injected directly into the prompt.
    *   **Graph Expansion**: Performs 2-hop BFS.
*   **agentmemory**: Triggers spreading activation during search by retrieving adjacent graph neighbors of query entities, but lacks a real-time temporal decay model for active workspace skills.

---

## 🛠️ 5. Tooling, Integration, & Developer Experience

The developer-facing interfaces represent two different integration paradigms:

*   **BrainRouter (Active, Agent-Guided Workflow)**:
    *   Equips the agent with tools for deliberate workflow management (e.g., `memory_working_offload` to move logs exceeding 1,000 tokens out of context, `memory_working_context` to monitor a Mermaid task canvas, and `memory_failed_attempts` to avoid repeating errors).
    *   Encourages the agent to actively manage state and signal citations (`memory_mark_cited`), placing the metacognitive control in the agent's hands.
    *   Built as an off-heap multi-tenant SQLite database.
*   **agentmemory (Passive, Hook-Driven Automation)**:
    *   Provides 12 automated lifestyle hooks for client agents (Claude Code / Codex CLI) that intercept `SessionStart`, `PreToolUse`, `PostToolUse`, `PreCompact`, and `Stop`. It captures everything in the background without requiring the agent to make manual calls.
    *   Provides an extensive MCP toolkit (51 tools) and a **real-time Electron/Web Viewer (port 3113)** featuring session replay, interactive timelines, and step-by-step scrubbing of prompts/tool calls.
    *   Runs as a background daemon powered by the Rust-based `iii-engine`.

---

## 📊 6. Comparison Matrix

| Feature | BrainRouter | agentmemory |
| :--- | :--- | :--- |
| **Primary Design Paradigm** | Active metacognitive network (agent-guided) | Passive hook-driven logger (automation-centric) |
| **Retrieval Architecture** | Dual-Process (System 1 + System 2) | Weighted Triple-Stream RRF + On-Device Rerank |
| **Index Types** | SQLite FTS5 (Lexical) + Vector + Filepaths | BM25 (Lexical) + Vector + Graph Entities |
| **Stage 3 Reranker** | External API-driven (Cohere `/v1/rerank` or local vLLM BAAI cross-encoder) | In-process local on-device quantized model (`Xenova/ms-marco-MiniLM-L-6-v2`) |
| **Time-Decay Model** | Exponential decay with category half-lives | Ebbinghaus decay with automatic TTL |
| **Synaptic LTP** | ACE loop citation boosts (up to +30%) | Access-frequency counters |
| **Pruning Mechanism** | Synaptic pruning (evicted if uncited $\geq 10$ times) | Contradiction detection & supersession |
| **Active Scene Management** | ContextualFocus Scenes with dynamic heat scores | None (relies on query-time retrieval) |
| **Workspace Skill Pre-warming** | Yes (Memetic potential decay / `<skill-prewarm>`) | None |
| **Context Control Tools** | Working offloads, task states, failed attempts | None |
| **Developer Integrations** | Explicit agent tools | 12 client hooks, 51 MCP tools, web/GUI viewer |
| **Underlying Engine** | Local multi-tenant SQLite (C-based off-heap) | `iii-engine` (Rust actor network) + SQLite |

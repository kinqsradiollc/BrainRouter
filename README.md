# 🧠 BrainRouter

**Dynamic Context Gateway & Multi-Agent Memory Core**

BrainRouter is a multi-tenant, hierarchical memory engine and context router for autonomous AI agents. It is built for **software engineers** who rely on AI coding assistants day-to-day — tools like Claude Code, Cursor, and Windsurf — and who constantly hit the same frustrations: agents that forget decisions made an hour ago, prompts bloated with every rule and guideline you've ever written, and IDE sessions that are completely blind to what your terminal agent just changed.

BrainRouter solves these problems by acting as a persistent, intelligent brain that all your agents share. Rather than loading everything into every prompt, it learns what you're actively working on and surgically injects only the context that matters, right when it matters.

---

## Who This Is For

BrainRouter is built specifically for **software engineers, AI engineers, and engineering teams** that:

- Use AI coding assistants heavily across multiple tools (CLI, IDE, browser)
- Maintain complex codebases with architectural rules, API contracts, and design guidelines
- Find that their AI agents frequently "forget" past decisions or repeat the same mistakes
- Want agents that understand their personal coding style, preferences, and project context without manual re-prompting

---

## The Problem It Solves

Standard AI prompt engineering has a fundamental ceiling. You write a `CLAUDE.md` or `AGENT.md` that describes your project conventions, then paste it into every session. The prompt bloats. The agent's attention dilutes. It starts ignoring your styling rules mid-task. Switch to a new terminal window and start from scratch.

BrainRouter replaces the static prompt with an active memory engine. Your agents now share a synchronized brain that knows your history, your preferences, your current task, and what skills are relevant — and it delivers that context dynamically, exactly when needed.

---

## How Memory Works: The Layers

BrainRouter organizes all information through a strict hierarchy. Every piece of knowledge is classified by how processed and distilled it is. This ensures that what gets injected into the agent's context is always signal, never noise.

### Long-Term Memory Layers (Persistent across sessions)

**L0 — Raw Turn Logs**
Every agent interaction is recorded at this layer: your messages, the agent's responses, and every tool call output. This is the raw, unprocessed record of everything that happened. Sensitive data (API keys, tokens, passwords) is automatically scrubbed before being written to the database.

**L1 — Distilled Memories**
An asynchronous pipeline reads L0 logs and uses an LLM to extract high-value, isolated facts. These become your long-term episodic memories: an API contract you described, a database schema decision, a bug you fixed and how. Each memory is stored as a vector embedding using `sqlite-vec` for fast semantic retrieval. Duplicate and near-identical memories are automatically merged.

**L1.5 — Contradiction Resolution**
As L1 memories accumulate, they undergo pairwise logical evaluation. If a new instruction contradicts an existing one (e.g., "use Tailwind" vs. "use vanilla CSS"), the system flags it as an active contradiction and surfaces it on the dashboard for human review. This prevents the agent from silently holding two conflicting beliefs at once.

**L2 — Scene Nodes**
Memories are dynamically clustered into "Scenes" — situational contexts defined by what you were working on. If you're actively editing database schemas, the system clusters database-related memories into a hot Scene and elevates them during recall. Scenes cool down as you move to other tasks, and their associated memories fade from the active foreground.

**L3 — User Personas**
The highest distillation layer. Over time, the system builds a persistent profile of your technical preferences: the frameworks you favor, your code style tendencies, your preference for verbose versus terse explanations. This persona is maintained per-user, across all sessions.

### Working Memory Tiers (Short-term, session-scoped)

When an agent runs a command that returns thousands of lines — a massive `git diff`, a full directory listing, a long build log — it's impractical and wasteful to dump that raw output directly into the LLM context. BrainRouter uses a 4-tier compaction system to handle this cleanly.

**W0 — Raw Refs**
The full payload is saved to a local disk file (`.brainrouter/work/<session>/refs/*.md`) and the agent receives a compact reference ID instead. The raw data is preserved for retrieval but never floods the context window.

**W1 — Step Logs**
A compact JSONL-based execution history is maintained, tracking what the agent actually did (the steps and outcomes), not the raw output text.

**W2 — Mermaid Canvas**
The current state of complex tasks is translated into a lightweight Mermaid diagram. Instead of re-reading gigabytes of file diffs to understand where things stand, the agent reads a structured visual representation of the task graph.

**W3 — Injected State**
The final, maximally-compressed context block that actually gets injected into the LLM prompt. It contains the active goal, the W2 visual canvas, and any critical constraints — everything the agent needs to continue exactly where it left off, in as few tokens as possible.

---

## How Skills Work: The Agent Knowledge Layer

Beyond memory, BrainRouter ships with a library of **Skills** — modular, markdown-based instruction sets that teach agents how to do specific engineering tasks well.

A skill is not a static prompt. It is a structured workflow with defined steps, exit criteria, and acceptance checklists. When a skill becomes relevant to your current task, BrainRouter automatically injects it into the agent's context using the SNN pre-warming system. When the task is done and the skill goes unused, it decays out of context on its own.

Skills cover the full software engineering lifecycle:

| Domain | Examples |
|---|---|
| **Architecture & Planning** | `planning-and-task-breakdown`, `spec-driven-development`, `idea-refine` |
| **Implementation** | `api-skill`, `conventions-skill`, `incremental-implementation` |
| **Quality & Testing** | `testing-skill`, `code-review-and-quality`, `doubt-driven-development` |
| **Debugging** | `debugging-and-error-recovery`, `api-layered-debugging` |
| **Design** | `design-taste-frontend`, `doc-management-skill` |
| **Memory & Context** | `agent-memory`, `context-engineering` |
| **DevOps & Delivery** | `ci-cd-and-automation`, `docker-lifecycle-engineering`, `shipping-and-launch` |
| **Agent Methodology** | `source-driven-development`, `interview-me`, `using-agent-skills` |

Skills are global — they live in the BrainRouter server and are available to any agent connecting to it. They are loaded on-demand using `mcp_brainrouter_get_skill(name: "...")`, so they never bloat the base prompt.

---

## How Context Pre-Warming Works (SNN Routing)

BrainRouter tracks what your agent is actively doing and builds an activation score for each relevant skill. This is inspired by Spiking Neural Networks (SNNs): each tool call or task type "spikes" the associated skill's activation potential. Potentials are capped at `4.0` and decay exponentially over time and turns when unused.

When a skill's potential crosses the pre-warming threshold (`1.5` by default), its instruction set and associated memories are automatically injected into the next prompt. When you finish that task and move on, the skill naturally decays below threshold and stops taking up context space.

You can tune the routing behavior via environment variables:

```env
BRAINROUTER_SKILL_HALF_LIFE_MINUTES=10   # How fast skills decay
BRAINROUTER_SKILL_MIN_TURN_DECAY=0.05   # Minimum decay per turn
BRAINROUTER_SKILL_PREWARM_THRESHOLD=1.5  # Injection threshold
BRAINROUTER_SKILL_SPIKE_AMOUNT=1.0      # Spike per trigger
BRAINROUTER_SKILL_MAX_POTENTIAL=4.0     # Ceiling potential
```

---

## Architecture Overview

BrainRouter is a TypeScript monorepo. The server exposes both an MCP (Model Context Protocol) endpoint for direct agent integration and a REST API for the dashboard and SDK.

| Package | Purpose |
|---|---|
| `mcp/` (`@brainrouter/mcp-server`) | Express + MCP server. Hosts the memory engine, distillation pipeline, and SQLite store |
| `packages/types/` (`@brainrouter/types`) | Shared TypeScript interfaces across REST APIs, memory layers, and configs |
| `packages/sdk/` (`@brainrouter/sdk`) | Type-safe client SDK (`BrainRouterClient`) for all REST API endpoints |
| `packages/hooks/` (`@brainrouter/hooks`) | React Hooks for syncing dashboard panels with live memory and activations |
| `web/` (`dashboard`) | Next.js Obsidian-theme dashboard visualising potentials, memories, and contradictions |

For full architecture diagrams, pipeline flows, math, and API reference, see [BRAINROUTER.md](./BRAINROUTER.md).

---

## Getting Started

### Prerequisites
- **Node.js** v22+ (required for native `node:sqlite` support)
- **npm** v10+

### Installation

```bash
npm install
```

### Environment Variables

Create a `.env` file in the root directory:

```env
# Server configuration
PORT=3747
USE_HTTP=true

# Security
BRAINROUTER_JWT_SECRET=your_secure_random_jwt_secret_here

# Skill routing (tune to your workflow)
BRAINROUTER_SKILL_HALF_LIFE_MINUTES=10
BRAINROUTER_SKILL_MIN_TURN_DECAY=0.05
BRAINROUTER_SKILL_PREWARM_THRESHOLD=1.5
BRAINROUTER_SKILL_SPIKE_AMOUNT=1.0
BRAINROUTER_SKILL_MAX_POTENTIAL=4.0
```

### Running the MCP Server

```bash
npm run dev -w @brainrouter/mcp-server
```

Once running:
- **MCP SSE Transport:** `http://localhost:3747/mcp`
- **REST API:** `http://localhost:3747/api`
- **Health Check:** `http://localhost:3747/health`

### Running the Dashboard

```bash
npm run dev -w dashboard
```

Open [http://localhost:3000](http://localhost:3000) to view the real-time skill activation curves, memory browser, and contradiction resolver.

### Running Tests

```bash
npm test
```

---

## Documentation

| File | Description |
|---|---|
| [BRAINROUTER.md](./BRAINROUTER.md) | Deep-dive: SNN math, pipeline diagrams, API routes, package breakdown |
| [AGENT.md](./AGENT.md) | Quick-start guide for agents: which skills to load per scenario |
| [AGENT_TEMPLATE.md](./AGENT_TEMPLATE.md) | Template version of AGENT.md for use in your own projects |
| [PRESENTATION.md](./PRESENTATION.md) | Slide-format overview for sharing the concept with your team |

---

## License

MIT — see [LICENSE](./LICENSE)

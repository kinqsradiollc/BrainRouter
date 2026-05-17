# 🧠 BrainRouter

**Give your AI coding agent a Brain, a Map, and a Memory.**

BrainRouter is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that solves the biggest frustration with AI coding assistants: they forget everything between sessions, scan entire repos on every question, and never learn how you actually work.

BrainRouter gives your agent:
- 🧠 **A Brain** — 40+ expert skill playbooks (debugging, code review, shipping, design systems, and more)
- 📚 **A Map** — an `AGENT.md` router that directs the agent to exactly the right skill, instantly
- 💾 **A Memory** — a persistent, hierarchical memory engine that remembers your preferences, project history, standing rules, and working style across every session

Works with: **Cursor · VS Code / GitHub Copilot · Claude Desktop · Antigravity (Gemini) · OpenAI Codex · any MCP-compatible tool.**

---

## Why BrainRouter?

Every time you start a new AI conversation, the agent starts from zero. You re-explain your stack, re-state your preferences, re-teach your conventions. BrainRouter ends that.

After setup, your agent will:
- **Remember your rules** — "always use pnpm", "never deploy on Fridays"
- **Remember your history** — decisions made, bugs fixed, features shipped
- **Remember your style** — how you like responses structured, what level of detail you prefer
- **Know which playbook to follow** — no more guessing or scanning
- **Surface conflicts** — if an old rule contradicts a new one, it tells you instead of silently picking one

> Inspired by [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory) research, which showed structured memory improves agent task success by 51% and cuts token costs by 61%.

→ **See [ROADMAP.md](./ROADMAP.md)** for the full feature roadmap and research behind each planned feature.

---

## 🏗️ Architecture

BrainRouter runs on a **dual-registry system**:

| Registry | Location | Contents |
|---|---|---|
| **Global** | This repo (`BrainRouter/`) | Universal, battle-tested skills, personas, references |
| **Local** | Your project (`--root`) | Project-specific skills & docs that shadow global ones |

The `--root` flag tells the server which project it's working on. Local skills with the same name as global ones **automatically override** the global version — no config needed.

---

## 🧠 Memory Engine

BrainRouter's memory engine is a 4-layer semantic pyramid. Raw conversations are saved at the base; distilled wisdom lives at the top. Each layer is progressively more compact and useful.

```
               ┌──────────┐
               │  L3      │  ← Your personality profile (who you are, how you think)
               │ Persona  │
              /└──────────┘\
             / ┌──────────┐ \
            /  │  L2      │  \  ← Narrative chapters of your projects
           /   │  Scenes  │   \
          /    └──────────┘    \
         /  ┌─────────────┐    \
        /   │    L1.5     │     \  ← Contradiction detection (BrainRouter original)
       /    │ Conflicts   │      \
      /     └─────────────┘       \
     /    ┌───────────────┐        \
    /     │      L1       │         \  ← Extracted facts (4 memory types)
   /      │ Extracted     │          \
  /       │ Memories      │           \
 /        └───────────────┘            \
─────────────────────────────────────────
│                   L0                   │  ← Every conversation, verbatim
│         Raw Conversation Storage       │
└────────────────────────────────────────┘
```

### The 4 Memory Layers

| Layer | What It Stores | When It Runs |
|---|---|---|
| **L0** | Every raw conversation message, fully searchable | Every turn |
| **L1** | Extracted facts — persona, episodic events, instructions, skill patterns | Every ~5 turns |
| **L1.5** | Contradiction flags — conflicting instructions detected and stored | After every L1 run |
| **L2** | Narrative scene chapters — clusters of related memories | Every ~20 new memories |
| **L3** | Full persona profile — who you are, how you work, how you think | Every ~50 new memories |

### The 4 Memory Types (L1)

| Type | What It Captures | How Long It Stays Relevant |
|---|---|---|
| `persona` | Stable preferences and traits | 180 days (fades slowly) |
| `episodic` | Events that happened, with dates | 30 days (fades faster) |
| `instruction` | Rules you gave the agent | **Never fades** |
| `skill_context` | How *you* use specific skill workflows | 7 days (current habits) |

> **Memory decay:** Different memory types fade in relevance over time (like forgetting an old meeting but remembering a long-standing rule). BrainRouter applies half-life scoring so recent, relevant context always bubbles to the top — old noise doesn't crowd out new signal.

### Recall: Hybrid Search

Before every response, BrainRouter runs two searches in parallel and merges them:
- **Keyword search (BM25)** — finds memories containing your exact words
- **Semantic search (vector similarity)** — finds memories with the same *meaning*, even if the words differ

Results are merged using Reciprocal Rank Fusion (RRF) and scored with half-life decay. The top memories are injected into the agent's context in milliseconds. A 5-second timeout ensures the agent is never blocked.

### Contradiction Detection (L1.5)

When a new memory conflicts with an existing one (e.g., "use npm" vs. "use pnpm"), BrainRouter flags it and surfaces a warning during the next relevant conversation. Instead of silent bugs, you get explicit agent warnings: *"I see conflicting instructions — which should I follow?"*

---

## ⚡ How the MCP Transport Works

> **This is important — it explains why there's no server URL.**

BrainRouter uses **stdio transport** by default:

- The AI tool **spawns BrainRouter automatically** when it starts
- Communication happens through **stdin/stdout pipes** (not a network port)
- **No URL, no port, no `npm run dev` needed** — the tool manages the process lifecycle

```
AI Tool  ──spawn──▶  node dist/index.js --root /your/project
         ◀──stdio──▶  (MCP messages over pipes)
```

### Want a URL-accessible server instead?

Switch to **Streamable HTTP transport** for sharing over a network or Docker:

```bash
node dist/index.js --root /path/to/project --http --port 3747
```

---

## 🚀 Setup

### Step 1 — Clone & Build

```bash
git clone https://github.com/kinqsradiollc/BrainRouter.git
cd BrainRouter/mcp
npm install
npm run build
```

### Step 2 — Generate configs for your project

```bash
# From inside BrainRouter/mcp/
npm run setup:mcp -- /path/to/your/project
```

This writes ready-to-paste config files into `<your-project>/.brainrouter/`:

```
YourProject/
  .brainrouter/
    mcp.cursor.json        ← ⚡ Cursor
    mcp.vscode.json        ← 🐙 VS Code / GitHub Copilot
    mcp.claude.json        ← 🟣 Claude Desktop
    mcp.antigravity.json   ← ✨ Antigravity (Gemini)
    mcp.codex.json         ← 🤖 OpenAI Codex
    mcp.json               ← 📄 Generic
```

### Step 3 — Paste into your AI tool

Open the relevant file and paste (or merge) the `mcpServers` block into your tool's config:

```json
{
  "mcpServers": {
    "brainrouter": {
      "command": "node",
      "args": [
        "/absolute/path/to/BrainRouter/mcp/dist/index.js",
        "--root",
        "/absolute/path/to/your/project"
      ]
    }
  }
}
```

#### Tool config locations

| Tool | Config file location |
|---|---|
| ⚡ **Cursor** | `~/.cursor/mcp.json` or `<project>/.cursor/mcp.json` |
| 🐙 **VS Code / Copilot** | `<project>/.vscode/mcp.json` |
| 🟣 **Claude Desktop** (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| 🟣 **Claude Desktop** (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| ✨ **Antigravity (Gemini)** | `~/.gemini/antigravity/mcp_config.json` |
| 🤖 **OpenAI Codex** | `~/.codex/config.json` |

### Step 4 — Restart your AI tool

Fully restart the tool after editing its config. It will spawn the BrainRouter server automatically on next launch.

---

## 📡 Remote MCP / HTTP (Optional)

Use this if you want BrainRouter accessible via a URL (e.g., shared across machines, or via Docker).

```bash
# Start BrainRouter as an HTTP server
node dist/index.js --root /path/to/project --http --port 3747
```

Then configure your tool with a `serverUrl` instead of `command`:

```json
{
  "mcpServers": {
    "brainrouter": {
      "serverUrl": "http://localhost:3747/mcp"
    }
  }
}
```

Verify the server is running: `curl http://localhost:3747/health`

---

## 🤖 AGENT.md — Telling Your AI to Use BrainRouter

Once connected, create an `AGENT.md` in your project root:

```markdown
# Agent Context Router

You are connected to the BrainRouter MCP Server.
Do NOT guess how to perform tasks. Use your MCP tools first.

## Workflow

1. **Recall Memory:** Call `memory_recall` to load persona, active scenes, and relevant past instructions.
2. **Find Skills:** Run `list_skills` or `search_skills` to find relevant procedures.
3. **Execute:** Run `get_skill` to load the `workflow` section of the matched skill.
4. **Context:** Run `list_docs` + `get_doc` to read project source-of-truth before writing code.
5. **Capture Memory:** Call `memory_capture_turn` after your response to persist the interaction.

**If unsure of your role:** use `get_persona` (e.g. `code-reviewer`, `security-auditor`)
```

Start a chat with: *"Read AGENT.md and let's get to work."*

---

## 📁 Local Skill Overrides

Inside your project, create any of:

```
your-project/
  skills/     ← project-specific skills (shadow global ones by name)
  agents/     ← project personas
  references/ ← project reference docs
  docs/       ← structured markdown docs (read via get_doc)
```

Local skills with the same name as a global BrainRouter skill **automatically override** the global version for that project.

---

## 🛠️ Available MCP Tools

### Skill & Knowledge Tools

| Tool | Description |
|---|---|
| `list_skills` | List all skills (global + local merged) |
| `get_skill` | Fetch a skill section (overview, workflow, checklist…) |
| `search_skills` | Fuzzy search across all skills |
| `get_persona` | Fetch a persona definition |
| `get_reference` | Fetch a reference document |
| `list_docs` | List project docs |
| `get_doc` | Read a project doc or specific section |
| `create_skill` | Scaffold a new skill in the local project or global registry |
| `update_skill` | Update an existing skill section (supports shadowing) |

### Memory Tools

| Tool | Description |
|---|---|
| `memory_capture_turn` | Record a completed conversation turn for memory processing |
| `memory_recall` | Retrieve relevant memories, persona, and scenes before responding |
| `memory_search` | Perform a targeted search across memory records |
| `memory_contradictions` | List or resolve conflicting instructions in memory |
| `memory_register_skill_hints` | Register extraction hints to guide memory capture when a skill is active |

---

## 📚 Skills Library (Sample)

BrainRouter ships with 40+ global skills across categories:

| Category | Skills |
|---|---|
| 🤖 **Agent Workflows** | `spec-driven-development`, `debugging-and-error-recovery`, `planning-and-task-breakdown`, `incremental-implementation`, `shipping-and-launch` |
| 📦 **Code Quality** | `code-review-and-quality`, `conventions-skill`, `code-simplification`, `concerns-skill` |
| 🎨 **Design** | `soft-skill`, `gpt-taste`, `minimalist-ui`, `industrial-brutalist-ui`, `concept-diagrams` |
| 🐳 **DevOps** | `docker-lifecycle-engineering`, `ci-cd-and-automation`, `git-workflow-and-versioning` |
| 💾 **Memory** | `agent-memory` (teaches agents how to use memory tools) |
| 🔒 **Security** | `security-auditor` persona |
| 🧪 **Testing** | `testing-skill`, `browser-testing-with-devtools` |

---

*Built for High-Density Engineering.*
*Memory architecture inspired by [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory) (Tencent Research).*

# 🧠 BrainRouter

**A High-Performance Context Firewall & MCP Server for AI Agents.**

BrainRouter is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives your AI coding agents a structured **Brain** and **Map**. Instead of blindly scanning your entire repository, the agent queries BrainRouter for exactly the skill, doc, or persona it needs — on demand.

Works with: Claude Desktop · Cursor · VS Code / GitHub Copilot · Windsurf · Antigravity · OpenAI Codex · any MCP-compatible tool.

---

## 🏗️ Architecture

BrainRouter runs on a **dual-registry system**:

| Registry | Location | Contents |
|---|---|---|
| **Global** | This repo (`BrainRouter/`) | Universal, battle-tested skills, personas, references |
| **Local** | Your project (`--root`) | Project-specific skills & docs that shadow global ones |

The `--root` flag tells the server which project it's working on. Local skills with the same name as global ones **automatically override** the global version.

---

## ⚡ How the MCP Transport Works

> **This is important — it explains why there's no server URL.**

BrainRouter uses **stdio transport** by default. This means:

- The AI tool **spawns the BrainRouter process itself** when it starts
- Communication happens through **stdin/stdout pipes** (not a network port)
- **No URL, no port, no `npm run dev` needed** — the tool manages the process lifecycle
- `npm run dev` / `npm start` are only for debugging the server in isolation

```
AI Tool  ──spawn──▶  node dist/index.js --root /your/project
         ◀──stdio──▶  (MCP messages over pipes)
```

### Want a URL-accessible server instead?

If you want to run BrainRouter as an HTTP server (shareable over a network or via Docker), that requires switching to the **Streamable HTTP transport** — see [Remote MCP](#-remote-mcp-http-optional) below.

---

## 🚀 Setup

### Step 1 — Clone & Build

```bash
git clone https://github.com/[YOUR_USERNAME]/BrainRouter.git
cd BrainRouter/mcp
npm install
npm run build
```

### Step 2 — Generate configs for your project

Run the setup script pointing at the project you want BrainRouter to work on:

```bash
# From inside BrainRouter/mcp/
npm run setup:mcp -- /path/to/your/project

# Example:
npm run setup:mcp -- /Users/anhdang/Documents/Github/DateDrop
```

This writes ready-to-paste config files into `<your-project>/.brainrouter/`:

```
DateDrop/
  .brainrouter/
    mcp.cursor.json        ← ⚡ Cursor
    mcp.vscode.json        ← 🐙 VS Code / GitHub Copilot
    mcp.claude.json        ← 🟣 Claude Desktop
    mcp.antigravity.json   ← ✨ Antigravity (Gemini)
    mcp.codex.json         ← 🤖 OpenAI Codex
    mcp.json               ← 📄 Generic
```

### Step 3 — Paste into your AI tool

Open the relevant file, review it, then paste (or merge) the `mcpServers` block into your tool's config. Each file looks like:

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

> Use this if you want BrainRouter accessible via a URL (e.g. shared across machines, or via Docker).

The MCP spec supports a **Streamable HTTP** transport. To use it, configure your tool with a `serverUrl` instead of `command`:

```json
{
  "mcpServers": {
    "brainrouter": {
      "serverUrl": "http://localhost:3747/mcp",
      "headers": {
        "Content-Type": "application/json"
      }
    }
  }
}
```

> ⚠️ **HTTP transport is not yet implemented** in this build. The current server only supports stdio. A future release will add `--http` / `--port` flags to start the HTTP server.

---

## 🤖 AGENT.md — Telling Your AI to Use BrainRouter

Once connected, create an `AGENT.md` in your project root:

```markdown
# Agent Context Router

You are connected to the BrainRouter MCP Server.
Do NOT guess how to perform tasks. Use your MCP tools first.

## Workflow

1. Run `list_skills` or `search_skills` to find relevant procedures
2. Run `get_skill` to load the `workflow` section of the matched skill
3. Run `list_docs` + `get_doc` to read project source-of-truth before writing code

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
  docs/       ← structured markdown docs (read via get_doc / update_doc)
```

Local skills with the same name as a global BrainRouter skill **automatically override** the global version for that project.

---

## 🛠️ Available MCP Tools

| Tool | Description |
|---|---|
| `list_skills` | List all skills (global + local merged) |
| `get_skill` | Fetch a skill section (overview, workflow, checklist…) |
| `search_skills` | Fuzzy search across all skills |
| `get_persona` | Fetch a persona definition |
| `get_reference` | Fetch a reference document |
| `list_docs` | List project docs |
| `get_doc` | Read a project doc or specific section |
| `update_doc` | Write/update a section in a project doc |
| `create_skill` | Scaffold a new skill in the local project |
| `update_skill` | Update an existing skill section |

---

*Built for High-Density Engineering.*

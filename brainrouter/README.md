# 🧠 BrainRouter Terminal Agent CLI

A premium, autonomous terminal-based AI coding assistant and REPL that acts as your local agent. It leverages **BrainRouter's memory engine** for cognitive persistence (System 1/2 loops) and provides standard filesystem/terminal tools to solve complex coding tasks autonomously.

---

## Features
- **Dual-Tier Connection**: Connects to local MCP servers via standard I/O (stdio) or hosted multi-tenant servers over Streamable HTTP/SSE.
- **Double-Tier Memory Architecture**:
  - **System 1 (Heuristic Recall)**: Automatically retrieves active focus scenes, codebase facts, and skills *before* each LLM reasoning cycle.
  - **System 2 (Memory Consolidation)**: Autonomously extracts learning points, updates facts, and saves evidence via turn-by-turn memory capture.
- **Local Execution Harness**: Autonomous execution of files editing, directory listing, regex/string grep, and terminal command invocation (safely prompted for user verification).
- **Obsidian Dark / Midnight Ledger Aesthetics**: High-end command line styling, loader animations, and formatted terminal markdown output.

---

## Installation & Setup

1. **Build the Monorepo**:
   From the repository root:
   ```bash
   npm install
   npm run build
   ```

2. **Configure Provider and Server Profiles**:
   Run the interactive configurator to set up your LLM settings (OpenAI, local endpoints like Ollama/LM Studio) and active server profile.
   From the repository root:
   ```bash
   npm run cli config
   ```
   Or from the `brainrouter` package subdirectory:
   ```bash
   node dist/index.js config
   ```
   This generates and modifies settings stored in `~/.config/brainrouter/config.json`.

---

## CLI Usage

### Start Interactive Agent Session (REPL)
Starts the agent loop. It will automatically load the active server connection and prime the agent with active codebase memories.
From the repository root:
   ```bash
   npm run cli
   ```
   Or to run a specific command:
   ```bash
   npm run cli chat
   ```
   Or from the `brainrouter` package subdirectory:
   ```bash
   node dist/index.js chat
   ```
*Tip: You can override the active LLM model via `--model <name>` or profile via `--profile <name>`.*

Workspace detection:
- By default, BrainRouter uses the nearest project root with `AGENT.md`, `AGENTS.md`, or `.git`.
- If you run from this package directory during BrainRouter development, the CLI promotes the workspace to the monorepo root so tools see the whole project, not only `brainrouter/`.
- Override manually with `--workspace /absolute/path/to/project` or `BRAINROUTER_WORKSPACE=/absolute/path/to/project`.
- In the REPL, run `/workspace` to confirm the active root and session key.

### Host Login / Setup Connection
Interactively log in to a hosted HTTP/SSE BrainRouter deployment and test latency/connectivity:
From the repository root:
```bash
npm run cli login
```

---

## Interactive REPL Slash Commands

Within the chat session, type `/` to access commands:
- `/help` — List all available directive commands.
- `/status` — Display active server profile details, LLM model, server latency check, and database size stats.
- `/workspace` — Show active workspace root, launch directory, and BrainRouter session key.
- `/tools` — Show local workspace tools and MCP tools exposed to the LLM.
- `/doctor` — Check active profile, MCP connectivity, plan + session store health, and orchestration tool availability.
- `/skills` — Visualize all loaded BrainRouter skills and categories.
- `/plan` — Show the durable CLI task plan persisted under `.brainrouter/cli/tasks.json`.
- `/transcript [main|sessionKey]` — Show recent persisted transcript entries.
- `/roles` — List built-in agent roles (`explorer`, `architect`, `reviewer`, `worker`, `verifier`) with default access modes.
- `/agents` — List child agent sessions with status, role, label, and elapsed time.
- `/agent <id>` — Show child detail, prompt, final output, and recent transcript.
- `/spawn <role> <prompt>` — Spawn a child agent (parent narrates via the LLM tool call).
- `/wait <id> [timeoutMs]` — Wait for a child agent to finish.
- `/spec <title>` — Runs the **spec-driven-skill** and writes a full `spec.md` to `<workspace>/.brainrouter/cli/workflows/<slug>/spec.md`. Stops for approval before generating tasks.
- `/workflows` — List durable workflow folders with per-artifact status (`spec.md`, `tasks.md`, `walkthrough.md`).
- `/feature-dev <feature>` — Runs the catalogued **agentic-engineering-workflow** skill with explorer + architect orchestration. Writes `spec.md` and `tasks.md` to the workflow folder, then stops for user approval before worker implementation.
- `/review [scope]` — Runs the catalogued **code-review-and-quality** skill with 3 parallel reviewer agents (correctness, maintainability, conventions).
- `/implement-plan` — Runs the catalogued **incremental-skill** with a worker + verifier loop on the next pending plan item.
- `/skill <name> [input]` — Generic invoker for any skill in your `skills/` catalogue. The CLI fetches the skill body via the MCP `get_skill` tool, falls back to filesystem (`skills/**/SKILL.md`), and hands the agent a structured prompt that embeds the skill instructions plus orchestration affordances (`spawn_agent`, `update_plan`).

### Skill-driven workflows

The CLI ships with a thin slash → skill mapping (see `brainrouter/src/skillRunner.ts`). Slash commands do **not** carry monolithic hard-coded prompts; they delegate to the SKILL.md authored under `skills/`. This means improving a workflow is a documentation edit, not a code change. Add a new mapping in `SLASH_TO_SKILL` to expose a new slash command, or use `/skill <name>` to invoke any skill ad-hoc.

#### How the skill catalogue is discovered

The CLI resolves a skill body in this order:

1. **MCP `get_skill` tool** — the connected MCP server merges *global* skills (the canonical BrainRouter catalogue) with *local* skills the user authored under `<workspace>/skills/` or `<workspace>/projects/*/skills/`. Local skills shadow global ones on name conflict. This is the path used in normal operation.
2. **Filesystem fallback** (used only when MCP is unreachable) searches, in order:
   - `<workspace>/skills/**/SKILL.md`
   - `<workspace>/.brainrouter/skills/**/SKILL.md`
   - The installed `@brainrouter/mcp-server` package directory (resolved via `require.resolve`). This works because the MCP package bundles the canonical catalogue at publish time (see below).
3. Otherwise the CLI hands the agent a benign placeholder and asks it to use general judgement.

#### Catalogue bundling at publish time

The `@brainrouter/mcp-server` package ships with the full BrainRouter skill catalogue baked in, so a user who only runs `npm install @brainrouter/mcp-server brainrouter` in their own workspace gets all 70+ canonical skills out of the box — no monorepo checkout required.

This is done via two lifecycle scripts in `mcp/scripts/`:

- `prepack.mjs` — runs before `npm pack`/`npm publish`. Copies `skills/`, `agents/`, `references/`, and `docs/` from the monorepo root into the package directory and records what it copied in `.bundled-content.json`.
- `postpack.mjs` — runs after pack. Reads the marker and removes exactly what `prepack` added, leaving the working tree clean.

The MCP server's resolver ([mcp/src/resolver.ts](../mcp/src/resolver.ts)) prefers the package's own `skills/` when present (installed-package mode) and otherwise walks up to the monorepo root (development mode). Both layouts work identically from the CLI's point of view.

### Durable workflow artifacts (one folder per workflow)

All multi-step commands (`/spec`, `/feature-dev`, `/review`, `/implement-plan`) anchor to a workflow slug and write their outputs to:

```
<workspace>/.brainrouter/cli/workflows/<slug>/
  meta.json        # { slug, title, kind, createdAt, updatedAt, status }
  spec.md          # produced by /spec or /feature-dev phase 3
  tasks.md         # produced by /feature-dev phase 3
  walkthrough.md   # appended by /implement-plan as items ship
  review.md        # produced by /review
```

The orchestration prompts for these commands **require** the agent to call `write_file` with the exact workspace-relative path — no chat-only plans. Use `/workflows` to inspect what's on disk. `getCurrentWorkflow` tracks the most recent one so `/implement-plan` appends to it automatically.

The system prompt also directs the agent to redirect free-form spec/plan requests to `/spec` or `/feature-dev` instead of producing inline monoliths, so the "one place" rule survives even when you don't type a slash command.

### Memory-native flow

Each parent turn runs three memory queries in parallel before the LLM sees the user prompt:

1. **`memory_recall`** — cognitive memory most relevant to the prompt.
2. **`memory_working_context`** — current working canvas, so resumed sessions don't reset.
3. **`memory_task_state`** — open tasks / handover notes for this workspace.

The merged briefing (secrets redacted via `redactText`) is injected as a system message and the recalled record IDs are tracked through the whole turn. At end-of-turn, `selectCitedRecordIds` heuristically picks the records that actually informed the answer (by ID mention or distinctive content match) and reports them via `memory_mark_cited` — replacing the previous always-empty citation list, so System-1 recall actually learns.

Child agents (`spawn_agent`) skip the full briefing for speed but accept a `seedRecordIds: string[]` parameter so the parent can hand over what it already recalled. Long child outputs (≥ 6,000 chars) are automatically offloaded to `memory_working_offload` and only a preview + ref handle is returned to the parent — the main context-saving win when synthesizing multiple child reports.

After every turn, the CLI also asks `memory_contradictions` and surfaces a one-line warning in the REPL when newly-captured beliefs disagree with prior ones, so drift gets caught instead of silently accumulating.

Inspection commands:

- `/memory <query>` — search long-term cognitive memory (`memory_search`).
- `/recall <query>` — explicit `memory_recall`, no LLM turn.
- `/briefing` — what was recalled before the most recent turn.
- `/scenes` — list active focus scenes.
- `/working` — current working-memory canvas.
- `/forget <recordId>` — archive an obsolete memory.

The workflow commands `/feature-dev`, `/review`, and `/implement-plan` are now required to open with `memory_search` (plus `memory_graph_query` / `memory_file_history` / `memory_task_state` depending on the workflow) and pass `seedRecordIds` to children, so no exploration is ever duplicated across sessions.

### Child agent permissions

Child agents default to the safest mode for their role: `explorer`, `architect`, `reviewer` are `read`; `worker` is `write`; `verifier` is `shell`. Override with `access: "read" | "write" | "shell"` when calling `spawn_agent`. Shell execution from children runs unattended — only grant `shell` to trusted roles like `verifier`.
- `/config` — Output active configuration details (with security sanitization for API keys).
- `/compact` — Clear the active chat context while keeping the session identity.
- `/clear` — Wipe the chat history of the active session.
- `/exit` — Close connections and exit.

---

## Autonomous Tool Execution

The agent coordinates two scopes of tools:
1. **BrainRouter Memory Tools** (loaded dynamically via the MCP connection): `memory_recall`, `memory_capture_turn`, `list_skills`, etc.
2. **Local Workspace Tools**:
   - `read_file` — Reads content of a workspace file.
   - `write_file` — Overwrites or writes a new file.
   - `edit_file` — Performs safe single-match string search-and-replace.
   - `list_dir` — Lists directory paths.
   - `grep_search` — Platform-independent recursive search of code patterns.
   - `run_command` — Runs a shell command on your host (always requests manual confirmation first for safety).

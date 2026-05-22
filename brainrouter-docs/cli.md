# Brainrouter CLI — Full Reference

A memory-native terminal agent at [`brainrouter-cli/`](../brainrouter-cli/).
Treats the BrainRouter MCP as a first-class tool — cognitive memory shapes
every turn instead of being a sidecar.

## Run

```bash
npm run cli                                    # interactive REPL
node brainrouter-cli/dist/index.js run "..."   # one-shot
brainrouter agents [--json]                    # list child sessions
```

The CLI auto-spawns the MCP server in stdio mode unless your config points
at an HTTP server. See [configuration.md → MCP client config](configuration.md#mcp-client-config).

---

## Agent loop

```mermaid
graph TD
    Prompt[User prompt + @mentions] --> Brief[Pre-turn memory briefing]
    Brief --> Loop[Tool-call iteration]
    Loop -->|access-mode filter| Tools[Local + MCP tools]
    Tools -->|pre-tool hooks + hookify| Gate{Allowed?}
    Gate -->|allow| Run[Run tool]
    Gate -->|block| Loop
    Run --> Trace[OTEL trace + transcript append]
    Trace --> Loop
    Loop -->|no more tools| Capture[memory_mark_cited + memory_capture_turn]
    Capture --> Out([Final answer])
```

Each turn:

1. **Memory briefing** — recall + scenes + persona injected as a system message.
2. **Tool-call iteration** — bounded by `BRAINROUTER_MAX_TOOL_LOOPS` (default 60).
3. **Auto-compact** — when history grows past `BRAINROUTER_AUTO_COMPACT_TOKENS`.
4. **Capture** — cited record IDs are written back; the full turn is recorded for later extraction.

Tool calls open OTEL-style child spans under the turn's root span. Set
`BRAINROUTER_TRACE_LOG=path/to/trace.jsonl` to persist them.

---

## Access modes

| Mode | What it adds |
| --- | --- |
| **read** | `read_file`, `list_dir`, `grep_search`, `glob_files`, `fetch_url`, `web_search`, `update_plan`, `goal_complete`, `goal_blocked`, orchestration tools |
| **write** | All of `read` + `write_file`, `edit_file`, `apply_patch` |
| **shell** | All of `write` + `run_command` |

Cycle with **Shift+Tab**. Set explicitly with `/permissions read|write|shell`.

`run_command` is gated by a y/N confirmation prompt unless `/yolo on` is
set. Silent child agents refuse shell unless their parent has
auto-approve enabled — closes a privilege-escalation path where a
read-mode parent spawned a shell-mode child.

---

## Local tools

| Tool | Purpose |
| --- | --- |
| `read_file` | Read a workspace file, optionally a line range. |
| `write_file` | Create or overwrite a file. |
| `edit_file` | Replace exactly one substring. |
| `apply_patch` | Multi-file `*** Begin Patch / *** Update File / @@ / - / + / *** End Patch` envelope. |
| `list_dir` | List a workspace directory. |
| `grep_search` | String/regex search across files. |
| `glob_files` | Find files by glob pattern. |
| `run_command` | Shell command (gated by confirmation + optional sandbox). |
| `fetch_url` | HTTP GET; strips HTML tags; clamps at 15kB. |
| `web_search` | DuckDuckGo or `BRAINROUTER_WEB_SEARCH_ENDPOINT`. |
| `update_plan` | Create/update the durable task plan. |
| `goal_complete` | Mark the active `/goal` complete with proof. Hard-refuses while plan items are open. |
| `goal_blocked` | Mark the active `/goal` blocked with a reason + needed unblocker. |

### Orchestration tools (also local)

| Tool | Purpose |
| --- | --- |
| `spawn_agent` | Spawn one child. |
| `spawn_agents` | Spawn a batch in one tool call. |
| `list_agents` | List active children. |
| `wait_agent` / `wait_agents` | Block until child(ren) finish. |
| `read_agent_transcript` | Read child transcript. |
| `close_agent` | Close a finished child. |
| `route_agent` | Dry-run role inference without spawning. |

### MCP tools (selected)

`memory_recall`, `memory_search`, `memory_graph_query`, `memory_file_history`,
`memory_explain_recall`, `memory_failed_attempts`, `memory_verify`,
`memory_working_context`, `memory_working_offload`, `memory_working_reset`,
`memory_task_state`, `memory_task_update`, `memory_contradictions`,
`memory_governance_*`, `memory_engineering_*`, `memory_consolidate`,
`memory_diagnostics`, `list_skills`, `search_skills`, `get_skill`,
`get_persona`, `get_reference`, `list_template_docs`, `get_template_doc`.

The CLI hides a few MCP tools from the LLM because the auto-pipeline owns
them (`memory_capture_turn`, `memory_mark_cited`, `memory_resolve_session`,
`memory_register_skill_hints`, `memory_hook_register`, `memory_hook_status`).

---

## Slash commands

`/help` paginates by category on small terminals or shows everything on
tall ones. `/help <category>` drills in.

### Session

| Command | Purpose |
| --- | --- |
| `/sessions` | List recent chat sessions. |
| `/resume [id]` | Re-attach to a session and replay its transcript. |
| `/new [title]` | Start a fresh session (fresh sessionKey + bucket). |
| `/side [title]` | Branch a side-conversation; main session restored on `/back`. |
| `/btw "<note>"` | Quick side-conversation that ends after one turn. |
| `/fork [title]` | Fork the current chat into a new sessionKey. |
| `/rename <title>` | Rename the current session. |
| `/clear` | Wipe in-memory history (transcript on disk untouched). |
| `/compact` | LLM-driven summary replaces verbose history. |
| `/quit`, `/exit` | Exit. |

### Memory

| Command | Purpose |
| --- | --- |
| `/memory` | Open memory inspector (recall, scenes, persona, contradictions). |
| `/recall <query>` | Run `memory_recall` manually, show results inline. |
| `/briefing` | Show the last memory briefing (records, sources). |
| `/scenes` | List active focus scenes + heat scores. |
| `/forget <recordId>` | Archive a record (manual prune). |
| `/handover` | Generate a handover summary for paste into another agent. |
| `/explain <recordId>` | Run `memory_explain_recall` — why did this rank where it did. |
| `/trace [on\|off\|status]` | Toggle OTEL trace logging at runtime. |
| `/failed` | Show recent failed-attempt records (`memory_failed_attempts`). |
| `/verify <recordId>` | Flag a record for re-verification. |
| `/audit` | Run a governance audit. |
| `/export <path>` | Export the memory store. |
| `/import <path>` | Import a memory snapshot. |
| `/persona` | Show the current CoreIdentity. |
| `/skill-hints` | List registered skill keyword triggers. |
| `/diagnostics` | Show MCP-side memory diagnostics. |
| `/working` | Inspect the working-memory canvas. |
| `/memories <command>` | Filesystem consolidation (`/memories consolidate`, `/memories list`, etc.). |

### Workflow

| Command | Purpose |
| --- | --- |
| `/goal <text>` | Set a sticky goal; CLI auto-continues until complete/blocked. See [Goal state machine](#goal-state-machine). |
| `/goal pause\|resume\|clear\|status` | Lifecycle subcommands. |
| `/goal budget <N>` | Iteration cap. |
| `/goal tokens <N>` | Token cap (0 to clear). |
| `/goal edit <field> <value>` | Unified update (text / status / budget / tokens). |
| `/continue` | Resume after a loop-limit abort or paused continuation. |
| `/plan` | Show the durable task plan. |
| `/skills` | List BrainRouter skills (workflow docs). |
| `/skill <name>` | Load a skill and execute its instructions. |
| `/tools` | List local + MCP tool inventory. |
| `/spec <title>` | Scaffold a spec workflow folder. |
| `/feature-dev <title>` | Full spec → tasks → implement workflow. |
| `/review [target]` | Reviewer pass. |
| `/implement-plan` | Execute the current `tasks.md`. |
| `/approve` | Mark workflow complete; write `walkthrough.md`. |
| `/workflows` | List workflows in `.brainrouter/cli/workflows/`. |
| `/diff [--staged\|--all]` | Streaming `git diff --color=always`. |
| `/commit` | Compose a commit (uses the agent to draft a message). |
| `/loop <N> <command>` | Repeat a slash command N times (debug aid). |

### Orchestration

| Command | Purpose |
| --- | --- |
| `/roles` | List available agent roles. |
| `/agents [--json]` | List active children. |
| `/agent <id>` | Inspect one child. |
| `/spawn <role> <prompt>` | Spawn a child. |
| `/wait [id\|all] [--timeout=ms]` | Drain children. |
| `/kill <id>` | Force-close a child. |
| `/ps` | Running children snapshot. |
| `/stop` | Send stop signal to all running children. |
| `/auto-review` | Spawn a reviewer over current branch / changes. |

### Guard

| Command | Purpose |
| --- | --- |
| `/permissions [read\|write\|shell]` | Show / set access mode. |
| `/hooks` | List shell lifecycle hooks. |
| `/hookify [list\|add\|remove\|enable\|disable]` | Manage markdown guardrail rules. |
| `/yolo [on\|off]` | Auto-approve shell commands (off by default). |
| `/sandbox [on\|off\|status]` | Toggle `BRAINROUTER_SANDBOX` at runtime. |
| `/logout` | Clear cached API credentials. |

### Observability

| Command | Purpose |
| --- | --- |
| `/transcript [--full\|--tail=N]` | Show the JSONL transcript. |
| `/watch` | Live-tail the transcript as turns happen. |
| `/tokens` | Session / turn token usage + memory-savings counter. |
| `/feedback "<text>"` | Drop a feedback entry into `feedback.jsonl`. |
| `/rollout` | Show session bucket on disk (paths + sizes + mtimes). |
| `/debug-config` | Print resolved config (env, model, endpoint) for troubleshooting. |
| `/doctor` | Health snapshot: MCP latency, extraction status, errors, children, plan items, hookify rules. |

### UI / config

| Command | Purpose |
| --- | --- |
| `/help [category]` | Paginated help. |
| `/status` | One-line status: model / mode / branch / token meter / goal. |
| `/workspace` | Show / change workspace root. |
| `/config` | Show resolved config. |
| `/init` | Generate an `AGENT.md` for this workspace. |
| `/model [name]` | Show / switch chat model at runtime. |
| `/mcp [use <name>\|list]` | Switch MCP transport profile. |
| `/copy` | Copy the last assistant message to clipboard. |
| `/theme [auto\|light\|dark\|mono]` | Set color theme. |
| `/title <text>` | Set a custom terminal title. |
| `/personality [concise\|standard\|detailed\|pair-programmer]` | Communication overlay. |
| `/raw [on\|off]` | Toggle raw scrollback (skip markdown rendering). |
| `/vim` | Toggle vim keybindings for the REPL prompt. |
| `/keymap` | Show current keybinding overlay. |
| `/statusline mode,branch,pr,tokens,time,goal` | Comma-separated statusline segments. |
| `/mention` | Print the @file mention syntax help. |
| `/ide` | Detect / set IDE integration (VS Code, JetBrains). |
| `/apps`, `/plugins`, `/experimental` | Toggle gated feature surfaces. |

---

## `/compact` — context summarization

When history grows past `BRAINROUTER_AUTO_COMPACT_TOKENS` (default 80k),
the CLI asks the LLM for a structured summary:

```
# Goals
…
# Decisions made
…
# Files touched
…
# Open work
…
# Last user request
(verbatim)
```

Verbose history is then replaced with `[system, compactedSummary, lastUserMessage]`,
tagged so the next turn treats the summary as authoritative state.

Implementation: [`brainrouter-cli/src/prompt/compactor.ts`](../brainrouter-cli/src/prompt/compactor.ts).
Provider-agnostic — works against any OpenAI-compatible endpoint.

---

## Memory briefing

Every non-trivial turn opens with an injected briefing built from:

- `memory_recall` against the user prompt.
- `memory_search` if recall returns thin results.
- Active scenes (`memory_working_context`).
- Persona (`get_persona`).
- Recency window (recent transcripts).

The briefing is tagged with an HTML comment marker so the CLI can replace
it on each turn instead of stacking copies forever. Marker is stripped
before the payload reaches the LLM.

The CLI surfaces every memory tool call as a one-liner (`🧠 Briefing`,
`💾 Captured`, `📌 Reinforced`) so users see what was consulted.

---

## @file mentions

Type `@<path>` (or `@<glob>`) in your prompt to inline file contents:

```
brainrouter[shell]> please review @src/server.ts and @packages/**/*.md
```

The CLI:

1. Expands the mentions to absolute paths.
2. Reads and embeds each file inline at the top of the turn.
3. Prints `📎  Attached N files: @src/server.ts, @packages/**/*.md`.
4. Files over a budget threshold are auto-offloaded to working memory.

`/mention` shows the full syntax.

---

## Hookify — markdown guardrails

Drop `.md` files into `~/.brainrouter/workspaces/<encoded>/hooks/`:

```markdown
---
name: warn-debug-code
enabled: true
event: file
pattern: console\.log\(|debugger;
action: warn
---

🐛 Debug code detected — remember to remove before committing.
```

### Event taxonomy

| Tool | Hookify event | Fields exposed |
| --- | --- | --- |
| `run_command` | `bash` | `command` |
| `write_file` | `file` | `file_path`, `content`, `new_text` |
| `edit_file` | `file` | `file_path`, `old_text`, `new_text` |
| `apply_patch` | `file` | `new_text` |
| user prompt submit | `prompt` | `user_prompt` |
| agent stop | `stop` | `transcript` |

### Matching

- **`pattern: <regex>`** — single-field shortcut. Matches against the
  event's primary field (`command` for bash, `file_path`/`new_text` for
  file, etc.).
- **`conditions:`** — multi-field matchers. All must match (AND):

```markdown
---
name: block-sensitive-write
enabled: true
event: file
action: block
conditions:
  - field: file_path
    pattern: ^(secrets|credentials)/.*\.json$
  - field: new_text
    pattern: \"api_key\"|\"password\"
---

❌ Blocked — sensitive file write detected.
```

### Actions

- **`warn`** — appends the rule message to the tool summary in the REPL.
  Tool still runs.
- **`block`** — denies the call; the message is fed back to the model so
  it self-corrects.

Manage with `/hookify list|add|remove|enable|disable <name>`.

---

## Shell lifecycle hooks

Distinct from hookify — these are *shell scripts* the CLI runs at
lifecycle events (`pre-turn`, `post-turn`, `pre-tool`, `post-tool`).
Configured in `~/.brainrouter/workspaces/<encoded>/cli/hooks.json`:

```json
{
  "hooks": [
    {
      "id": "telemetry-post-tool",
      "event": "post-tool",
      "command": "/usr/local/bin/log-tool-call.sh",
      "enabled": true
    }
  ]
}
```

Env vars available to the child: `BRAINROUTER_HOOK_EVENT`,
`BRAINROUTER_HOOK_TOOL`, `BRAINROUTER_HOOK_PAYLOAD` (JSON). A non-zero
exit from a `pre-tool` hook blocks the tool call.

---

## Multi-agent orchestration

`spawn_agent` (one child) or `spawn_agents` (batch in one tool call)
dispatch to bounded roles.

### Roles

| Role | Access | Purpose |
| --- | --- | --- |
| **explorer** | read | Investigate code, surface key files and symbols |
| **architect** | read | Design alternatives + tradeoffs grounded in prior decisions |
| **reviewer** | read | Severity-ordered findings; cites prior reviews |
| **worker** | write | Implementation; must read before editing |
| **verifier** | shell | Run tests, typecheck, lint; reports blocker states |

Each role opens with a mandatory memory-first phase
(`memory_search` → `memory_graph_query` → file history) before doing
any work.

### Auto-router

When `role` is omitted from a `spawn_agents` entry, `inferRoleFromTask`
picks one from the leading verb / intent:

| Verb | Role |
| --- | --- |
| investigate / explore / map / find / inspect / audit / "where is" | `explorer` |
| design / propose / architect / plan / "tradeoff" / "spec" | `architect` |
| review / critique / evaluate / "code review" / "smell" | `reviewer` |
| test / verify / typecheck / "build passes" | `verifier` |
| _(default)_ | `worker` |

`route_agent({ task })` returns the inferred role + rationale without
spawning. Useful for sanity-checking a costly fan-out.

### Batch spawn

```ts
spawn_agents({
  agents: [
    { prompt: 'Investigate the auth middleware.', label: 'auth' },
    { prompt: 'Map the packages/types surface.', label: 'types' },
    { prompt: 'Design two search-filter options.', role: 'architect' }
  ]
})
// → { spawned: 3, agents: [{ id, role, access, status }, …] }

wait_agents({ ids: ['agent-...', 'agent-...', 'agent-...'], timeoutMs: 240000 })
```

### Child output handling

- Child outputs above ~6k chars auto-offload to the working-memory canvas
  (`memory_working_offload`). Parent inspects via
  `memory_working_context` instead of paying the context cost.
- Children are required to open with a `## Headline` block; the parent
  uses that section as the preview. Falls back to head+tail when missing.

### Headless multi-agent CLI

```bash
brainrouter agents --json
```

Lists active children from outside the REPL. Handy for tmux status bars.

---

## Workflow artifacts

Every multi-step request lands as files under
`.brainrouter/cli/workflows/<slug>/`:

```
spec.md              # what + why + boundaries
tasks.md             # ordered breakdown with status
walkthrough.md       # post-implementation summary
meta.json            # slug, started_at, status
```

Slash commands `/spec`, `/feature-dev`, `/review`, `/implement-plan`,
`/approve` scaffold these automatically.

`/workflows` lists existing folders; `/feature-dev <title>` runs the full
arc (spec → tasks → implement → review → approve).

---

## Personality overlays

`/personality <style>` injects a communication block into the system
prompt:

| Style | Behavior |
| --- | --- |
| `concise` | ≤ 2 sentences, no closing summaries when tool output is self-explanatory |
| `standard` | Default — no overlay |
| `detailed` | Walks through reasoning + post-task summary with file/line citations |
| `pair-programmer` | Narrates decisions, surfaces tradeoffs, invites redirection at forks |

Persists across restarts via `~/.brainrouter/workspaces/<encoded>/cli/preferences.json`.

---

## Goal state machine

`/goal <text>` sets a sticky outcome. The CLI auto-continues turns until
one of: `goal_complete(proof)`, `goal_blocked(reason)`, budget exhaustion.

### Lifecycle

| Status | Means |
| --- | --- |
| `active` | Continuation loop will fire after each turn |
| `paused` | User-initiated suspend (`/goal pause`) |
| `complete` | Outcome satisfied — loop halts permanently |
| `blocked` | Agent gave up — needs user input |
| `usage_limited` | Iteration or token budget exhausted; resumable after raise |

### Contracts

`goal_complete` is hard-refused if:

- The active plan (`update_plan`) still has `pending` or `in_progress` items.
- The same assistant message lacks user-visible prose. (Soft enforced — if
  the model skips prose, the CLI fallback surfaces the proof from
  `goal.json` so the user has something to read.)

`goal_blocked` is similar — the assistant must include user-visible
prose explaining what was tried and what the user needs to provide.

### Budgets

- **Iteration budget** (`/goal budget <N>`, default 10) — caps auto-continue
  turns.
- **Token budget** (`/goal tokens <N>`) — caps cumulative prompt+completion
  tokens. Optional; `0` clears.

When the next turn would be the last within either cap, the CLI injects
a "wrap up gracefully" steering message so the model lands soft instead
of being cut off mid-thought. The steering is dropped if the user raises
the cap before the next tick.

### Resume across sessions

`/resume <session>` will surface a y/N prompt to resume the goal if the
loaded session has a paused / blocked / usage_limited goal. Prevents the
"loop silently stays paused" footgun.

---

## Working-memory canvas

`memory_working_*` tools manage an active context canvas where large
child-agent outputs and analyses land. Each session has one canvas at
`~/.brainrouter/work/<user>/<workspace-hash>/<session>/`:

- `state.json` — current cursor + metadata.
- `steps.jsonl` — append-only log of canvas events.
- `canvas.mmd` — Mermaid diagram of the active context graph.
- `refs/` — referenced documents (e.g. offloaded child outputs).

Use cases:

- Parent agent fans out 5 explorers; each offloads 8kB of findings into
  `refs/`. Parent reads `memory_working_context()` once instead of pasting
  40kB back into its own context.
- Long-running goal accumulates a multi-file analysis the agent can
  re-read across iterations without paying the token cost each turn.

`/working` inspects the canvas. `memory_working_reset()` clears it.

---

## Filesystem memory consolidation

The MCP store is source of truth, but `/memories consolidate` writes a
human-readable view to `~/.brainrouter/workspaces/<encoded>/memories/`:

```
MEMORY.md              # one-line index
user.md                # role, expertise, goals
feedback.md            # do/avoid guidance the user validated
project.md             # in-flight deadlines, stakeholders, motivation
reference.md           # pointers to Linear / Grafana / GitHub
raw_memories.md        # unclassified records
rollout_summaries/     # one .md per session summary
```

Classification taxonomy: user / feedback / project / reference. Records
that don't classify land in `raw_memories.md` so nothing is lost.

Runs from the MCP tool `memory_consolidate` as well — any MCP-speaking
client can trigger it.

---

## Headless mode

```bash
node brainrouter-cli/dist/index.js run "summarize src/"
```

One-shot, non-interactive. Slash commands are rejected with exit code 2
(use the REPL).

```bash
brainrouter agents [--json]
```

Lists child sessions from outside the REPL — convenient for tmux-resurrect,
status bars, and external agent pickers.

---

## Storage

All CLI state lives under `~/.brainrouter/workspaces/<basename>-<sha8>/cli/`.
The memory store is at `~/.brainrouter/memory.db`. Workflow artifacts are
the only committable files (they live inside the workspace at
`.brainrouter/workflows/`).

See [configuration.md → Storage layout](configuration.md#storage-layout)
for the complete tree.

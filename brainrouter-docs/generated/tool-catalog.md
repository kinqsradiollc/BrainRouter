<!-- GENERATED FILE — do not edit by hand.
     Source: packages/core/src/extension/builtin/{toolSpecs,toolCatalog}.ts + command/catalog.ts.
     Regenerate: REGEN_CATALOG=1 npm --workspace packages/core test -- tool-catalog-drift
     Drift-checked by packages/core/src/tests/tool-catalog-drift.test.ts (ADR-041 A41-16). -->

# BrainRouter tool catalog

95 built-in agent tools, by access tier and action kind.

| Tool | Tier | Action kind | Parallel-safe | Description |
|------|------|-------------|---------------|-------------|
| `apply_patch` | write | file_edit | no | Apply a multi-file patch using the Begin/End envelope format ("*** Begin Patch / *** Update File: path / @@ context / -old / +new / *** Add File: / *** Delete File: / *** End Patch"). |
| `artifact_write` | read | read_only | no | Create or update a durable ARTIFACT — a self-contained, reusable piece of work the user will want to refer back to, edit, or keep: a design doc, a report, an HTML/SVG mockup, a diagram, a standalone code file. |
| `ask_user_choice` | read | read_only | no | Pause the turn and ask the human to commit to ONE of 2–4 mutually exclusive approaches. |
| `atlas_context` | read | read_only | yes | Query the workspace codebase map (the Atlas graph built by /atlas): with no query, returns the orientation — project, layers with sizes, and the guided tour heads; with a query, returns the files/symbols whose names, paths, tags, or summaries match it, so you can locate a subsystem without grepping. |
| `close_agent` | read | read_only | no | Mark a child agent session closed without deleting its transcript. |
| `close_worker` | read | read_only | no | Mark a worker thread closed (terminal). |
| `computer_use` | shell | computer | no | Control the real local desktop mouse/keyboard or capture a screenshot. |
| `connector_list` | read | read_only | yes | List the connectors configured for this workspace (GitHub, filesystem, web, Slack, Jira, Confluence, Notion, Linear, GitLab, Google Drive, Gmail, MCP). |
| `connector_run` | shell | network | no | Run one connector's ingest → memory checkpoint: fetch new documents from the source, persist them, and import them into memory so future recall can cite them. |
| `delegate_agent` | read | child_write | yes | Start one background child agent and keep working in the parent turn. |
| `design_detect` | read | read_only | yes | Run the deterministic design detector (ADR-056) over workspace UI files — html, css/scss, jsx/tsx, svelte, vue, astro — or over a supplied markup string. |
| `design_fidelity` | write | file_edit | no | Measure how faithfully a build matches an approved comp (ADR-056): compares two workspace PNGs — the comp (a prototype capture or supplied image) and a screenshot of the build — per region: structure (SSIM over blurred grayscale with a small translation search), colour (palette match), detail (high-frequency energy), and section bands. |
| `design_variants` | write | file_edit | no | Live variants (ADR-056): write N alternatives of ONE element into its source file inside a display:contents wrapper carrying data-brainrouter-variants (the dev server's HMR swaps them in; the original is variant 0 and shows first, the others are hidden until cycled). |
| `diagram_draft` | read | read_only | yes | Seed an ARCHITECTURE diagram document from the workspace codebase map (the Atlas graph built by /atlas): each enriched layer becomes a typed component with its facade files as `sources`, layer relationships become labelled connections (counted imports when no enrichment ran), capped at 12 by size with omissions named. |
| `diagram_render` | write | file_edit | no | Validate, deterministically render, and DELIVER a typed diagram document as one self-contained HTML (inline SVG, dark/light themes, pan/zoom/search/focus, no network) under `.brainrouter/diagrams/<slug>.html`, beside its specification (`<slug>.json`) and a receipt (`<slug>.html.receipt.json`: nine artifact checks, SHA-256 + bytes of spec and artifact, evidence summary). |
| `diagram_validate` | read | read_only | yes | Validate a typed diagram document (ADR-056): kinds architecture \| workflow \| sequence \| dataflow \| lifecycle, each `{ schemaVersion: 1, kind, meta: { title, … }, …element arrays }` with unknown fields rejected at every level. |
| `edit_file` | write | file_edit | no | Edit an existing file in the workspace by replacing a target substring with a replacement string. |
| `extract_result` | read | read_only | yes | Expand a large tool result that was handed off (you hold a `resultRef` instead of the full output). |
| `fetch_url` | read | network | yes | Fetch and extract clean text from an HTTP(S) URL using the configured in-house crawler. |
| `file_vulnerability` | read | read_only | no | Record one verified pentest finding. |
| `finish_scan` | read | read_only | no | Complete the active pentest only after every worker is terminal. |
| `glob_files` | read | read_only | yes | Recursively find files in the workspace matching a glob/wildcard pattern (e.g., "src/**/*.ts" or "*.json"). |
| `goal_blocked` | read | read_only | no | Mark the active /goal blocked. |
| `goal_complete` | read | read_only | no | Mark the active /goal complete. |
| `grep_search` | read | read_only | yes | Search workspace files for a REGULAR-EXPRESSION query (JS regex syntax — e.g. |
| `kill_command` | shell | shell | no | Terminate a background run_command by id (the counterpart to run_command({background:true}) / task_output). |
| `list_agents` | read | read_only | no | List all child agent sessions for the current workspace with status, role, and elapsed time. |
| `list_dir` | read | read_only | yes | List the contents of a directory in the workspace. |
| `list_mcp_resource_templates` | read | read_only | yes | List parameterized resource templates provided by MCP servers. |
| `list_mcp_resources` | read | read_only | yes | List resources provided by MCP servers. |
| `list_requests` | read | network | yes | List HTTP requests captured by the authorized pentest proxy. |
| `list_sitemap` | read | network | yes | List the authorized target sitemap recorded by the pentest proxy. |
| `lsp` | read | read_only | no | Semantic code navigation via the language server (exact, not fuzzy). |
| `mark_chapter` | read | read_only | no | Mark the start of a new chapter when the work shifts to a meaningfully different phase (exploration -> implementation -> verification, or a topic pivot). |
| `mcp_call` | read | network | no | Invoke an MCP tool by its exact name (from mcp_search) with the given arguments. |
| `mcp_describe` | read | read_only | yes | Return the full description and input JSON schema for one or more MCP tools by their exact name (as returned by mcp_search). |
| `mcp_refresh_catalog` | read | read_only | no | Re-scan connected MCP servers and return a summary of available tools grouped by server (with counts). |
| `mcp_search` | read | read_only | yes | Search the connected MCP tool catalog by keyword (matches tool name, server, and description) and return the best-matching tools, each with a one-line summary. |
| `notebook_edit` | write | file_edit | no | Edit a Jupyter notebook (.ipynb) cell by index. |
| `notify_when_idle` | read | read_only | no | Ask another local session (by its session key) to send you ONE message the next time it finishes a turn (goes idle), instead of polling it. |
| `planner_add` | read | file_edit | no | Capture an item in the planner. |
| `planner_complete` | read | file_edit | no | Mark a planner item done. |
| `planner_find` | read | read_only | yes | Search the planner by text across titles and notes. |
| `planner_schedule` | read | file_edit | no | Set aside time for a planner item. |
| `planner_today` | read | read_only | yes | Read the user's planner for today: committed items, the current or next time block, anything carried over, and how fresh each source is. |
| `profile_stage` | read | read_only | no | Advance a primary-agent stage from the active workspace profile plan. |
| `read_agent_transcript` | read | read_only | no | Read recent transcript entries (default 40) of a child agent session. |
| `read_file` | read | read_only | yes | Read the contents of a file from the workspace. |
| `read_mcp_resource` | read | read_only | yes | Read a specific resource from an MCP server by server id and URI. |
| `read_worker_summary` | read | read_only | no | Read a worker thread's rolling summary (summary.md) without waiting for it to finish. |
| `reconcile_steer` | read | read_only | no | Classify one pending Steer receipt before acting on it. |
| `remind` | read | read_only | no | Schedule a session-local reminder that is delivered to you at a later turn boundary (never mid-turn). |
| `repeat_request` | read | network | no | Replay a captured request through the authorized pentest proxy, optionally with a safe mutation. |
| `research_brief` | read | read_only | no | Emit a report-ready markdown research brief from the session ledger: every finding plus an explicit "Uncertainty & conflicts" section (corroborated vs single-source vs conflicting). |
| `research_note` | read | read_only | no | Record one claim with structured source provenance in the durable session research ledger. |
| `resume_agent` | read | child_write | no | Resume a previously closed, failed, stale, or completed child agent for one more turn. |
| `route_task` | read | read_only | no | Direct-first delegation dry-run. |
| `run_code` | shell | shell | no | Code Mode: run ONE JavaScript program that calls your tools as async bindings — `await agent.read_file({path})`, `await agent.run_command({command})`, `agent.call(name, args)` — instead of many separate tool-call turns. |
| `run_command` | shell | shell | no | Run a shell command on the user's terminal. |
| `run_workflow` | read | child_write | no | Low-level deterministic multi-phase workflow target. |
| `run_workflow_graph` | read | child_write | no | Low-level saved visual workflow-graph target. |
| `scope_rules` | read | network | no | Read or replace the proxy scope rules for the authorized target. |
| `send_input` | read | child_write | no | Send a follow-up message to an existing child agent session, reusing its transcript. |
| `session_list` | read | read_only | yes | List the other conversations in this workspace (session key, title, turn count, last-modified time, and — for a forked session — which session it branched from). |
| `session_read` | read | read_only | yes | Read the recent transcript of another conversation in this workspace (get its sessionKey from session_list). |
| `session_reference` | read | read_only | yes | Pull a bounded snapshot of another session (get its sessionKey from session_list) into context as EXPLICITLY UNTRUSTED data. |
| `session_search` | read | read_only | yes | Search across this workspace's conversations for a text query. |
| `spawn_agent` | read | child_write | no | Spawn a child agent and a bounded prompt. |
| `spawn_agents` | read | child_write | no | Spawn several child agents in parallel with ONE tool call, and the primary way to work at high effort on a broad task. |
| `spawn_worker_thread` | read | child_write | no | Start a persistent background worker thread for a self-contained task. |
| `switch_model` | read | read_only | no | Switch THIS session to a named LLM profile (a saved model preset) for all subsequent model calls — e.g. |
| `task_agent` | read | child_write | yes | Launch a new agent to handle complex, multi-step tasks autonomously. |
| `task_output` | read | read_only | no | Read incremental output of a background run_command: returns { status, exitCode, chunk, nextOffset, complete }. |
| `terminal_list` | shell | read_only | yes | List live native terminal sessions owned by the current Desktop workspace. |
| `terminal_read` | shell | read_only | yes | Read bounded, plain-text output from a live native terminal. |
| `terminal_write` | shell | shell | no | Send bounded input to an existing live native terminal. |
| `track_query` | read | read_only | yes | Read the workspace project board (Track mode — one project per workspace). |
| `track_update` | read | read_only | no | Create or change project-board work (Track mode). |
| `update_plan` | read | read_only | no | Create or update the durable CLI task plan. |
| `view_request` | read | network | yes | View one captured HTTP request and response by proxy request id. |
| `wait_agent` | read | read_only | no | Wait for a child agent to complete. |
| `wait_agents` | read | read_only | no | Wait for multiple child agents in parallel. |
| `wait_until` | read | read_only | no | Block until a workspace condition holds or the timeout elapses: a file exists, or a file contains a text marker. |
| `wait_worker` | read | read_only | no | Block until a worker thread finishes or the wait timeout elapses, then return its status + summary. |
| `web_search` | read | network | yes | Search the public web with the configured provider and return normalized results (title, url, snippet). |
| `workflow_progress` | read | read_only | no | Report progress on the active durable workflow run (PARITY-W1) so `/workflows` shows live status and progress survives a restart. |
| `workspace_create` | read | file_edit | no | Make a new record in another surface of the workspace from something you are looking at — a checklist line becomes a work item, a conclusion becomes a note, a "remind me to…" becomes a planner item. |
| `workspace_link` | read | file_edit | no | Record that one thing references another, by writing the reference into the referring record's own text. |
| `workspace_resolve` | read | read_only | yes | Follow a brainrouter:// reference and read the CURRENT state of what it points at — a note block, a planner item, a work item, a file, a symbol in a file (code/symbol/<path>#<name>), a conversation, or an attached document. |
| `workspace_update` | read | file_edit | no | Change something that already exists in the workspace — rename a note or a task, tick a todo, set a page's icon, move a work item to another status, write a value into a database row's column. |
| `worktree_create` | read | read_only | no | Create a NEW git worktree on a NAMED branch for THIS repository (under BrainRouter's worktree home) and attach it for read and edit — the way to put a feature in its own worktree. |
| `worktree_done` | read | read_only | no | Finish with a git worktree of THIS repository and remove it. |
| `worktree_enter` | read | read_only | no | Attach an existing git worktree of THIS repository so its files resolve for read and edit. |
| `worktree_list` | read | read_only | yes | List the git worktrees of the CURRENT repository as structured data: path, branch (or detached), locked/prunable flags, a best-effort dirty flag, which entry is the current workspace, and which you have already entered. |
| `write_file` | write | file_edit | no | Create a new file or completely overwrite an existing file in the workspace. |

## Slash commands

`/agent` · `/agents` · `/annotation` · `/approve` · `/apps` · `/artifact` · `/atlas` · `/attach` · `/audit` · `/auto-chain` · `/auto-review` · `/bg` · `/blackboard` · `/brain` · `/briefing` · `/broadcast` · `/btw` · `/build` · `/cd` · `/chapters` · `/clear` · `/commit` · `/compact` · `/config` · `/context` · `/continue` · `/copy` · `/debug-config` · `/delegation-policy` · `/design` · `/diagnostics` · `/diagram` · `/diff` · `/dm` · `/doctor` · `/effort` · `/exit` · `/experimental` · `/explain` · `/export` · `/export-chat` · `/failed` · `/feature-dev` · `/feedback` · `/fg` · `/find` · `/forget` · `/fork` · `/goal` · `/grill-me` · `/handoff` · `/handover` · `/help` · `/hookify` · `/hooks` · `/ide` · `/implement-plan` · `/import` · `/inbox` · `/init` · `/keymap` · `/kill` · `/learned` · `/login` · `/logout` · `/loop` · `/marketplace` · `/mcp` · `/memories` · `/memory` · `/mention` · `/mode` · `/model` · `/new` · `/pack` · `/permissions` · `/persona` · `/personality` · `/plan` · `/planner` · `/playbook` · `/plugin` · `/plugins` · `/policy` · `/profile` · `/ps` · `/queue` · `/quiet` · `/quit` · `/raw` · `/recall` · `/recap` · `/recent-denials` · `/refresh-memory` · `/release-notes` · `/reload-skills` · `/rename` · `/requirement` · `/resume` · `/review` · `/review-auto` · `/review-policy` · `/reviews` · `/rewind` · `/roles` · `/rollout` · `/router` · `/sandbox` · `/scenes` · `/schedule` · `/sessions` · `/side` · `/simplify` · `/skill` · `/skill-hints` · `/skills` · `/spawn` · `/spec` · `/status` · `/statusline` · `/steer` · `/stop` · `/theme` · `/tier` · `/title` · `/tokens` · `/tools` · `/trace` · `/track` · `/transcript` · `/usage` · `/verify` · `/vim` · `/wait` · `/watch` · `/where` · `/workers` · `/workflow` · `/workflows` · `/working` · `/workspace` · `/yolo`

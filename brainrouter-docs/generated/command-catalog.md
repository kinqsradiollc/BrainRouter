<!-- GENERATED FILE — do not edit by hand.
     Source: packages/core/src/command/catalog.ts (SLASH_COMMANDS + HELP_CATEGORIES).
     Regenerate: REGEN_CATALOG=1 npm --workspace packages/core test -- command-catalog-drift
     Drift-checked by packages/core/src/tests/command-catalog-drift.test.ts (ADR-046 D1). -->

# BrainRouter command catalog

141 slash commands across 7 help categories.

## Session & State

| Command | Description |
|---------|-------------|
| /help [category] | List commands; `/help <category>` for a focused page |
| /status | Connection status, LLM config, DB stats |
| /router | Provider-router status, catalog counts, primary chain, gateway, cooldowns |
| /workspace | Active workspace and session identity |
| /cd <path> | Move the session working directory (keeps transcript + memory; resets read-ledger and child/worktree context) |
| /where | Single-screen view of workspace, workflow, goal, plan, recall, children |
| /atlas | Build/enrich a codebase knowledge graph (files, symbols, summaries, layers, tour); explore it in the desktop Atlas panel |
| /doctor | Config, connection, memory extraction health |
| /policy [name] | Show or apply a policy profile (readonly / workspace / trusted) |
| /config [key] [value] | Settings panel; `/config theme dark` to set; `/config raw` for JSON dump |
| /login | In-REPL MCP profile editor (transport → fields → probe → save) |
| /clear | Clear chat history for the active session |
| /compact | LLM-driven compaction of the active session |
| /new [label] | Start a new chat with a fresh session key |
| /fork [label] | Fork this chat into a new session, keep prior context |
| /rename <label> | Rename the current session |
| /resume <id> | Resume a previous session by sessionKey |
| /rewind [n] [--files] | Timeline of the last 20 turns; /rewind <n> forks a session truncated to that turn; --files also restores workspace files to that turn (preview + confirm) |
| /sessions | List persisted sessions for this workspace |
| /export-chat [md\|json] [path] | Export this session transcript to a file |
| /find <query> | Search this session transcript (case-insensitive, highlighted matches) |
| /recap | Instant summary of this session — last prompt/answer, files touched, open plan/goal |
| /chapters | Table of contents from the agent's mark_chapter markers |
| /side <q> /btw <q> | Ephemeral side conversation in a forked session |
| /init | Re-run the onboarding wizard (Theme → Provider → API key → Model → MCP → AGENT.md) |
| ! <command> | Shell escape — run a shell command from the composer (sandboxed when cli.sandbox=on) |
| # <note> | Quick memory capture — save a note to the brain without an LLM turn |
| /exit /quit | Close MCP connection and exit |

## Memory & Recall

| Command | Description |
|---------|-------------|
| /memory <query> | Search long-term memory (memory_search) |
| /recall <query> | Explicit cognitive recall (no LLM turn) |
| /briefing | Show what was recalled before the most recent turn |
| /refresh-memory | Clear the pinned memory anchor; next turn re-pins a fresh briefing |
| /scenes | List active focus scenes |
| /working | Show the working-memory canvas |
| /working reset confirm | Clear the canvas |
| /forget <recordId> | Archive a memory record by ID |
| /memories | Manage memory pipeline + consolidate to filesystem |
| /brain [agents] | Brain-agent health: per-agent status, 24h success rate, pending jobs |
| /blackboard [review\|list\|restore\|commit\|reject\|reconcile] | Review staged memory candidates; restore wrongly rejected/duplicate ones |
| /learned [all] | What your agent has learned about how to work, and how it is doing |
| /learned show <id> | One learned item with its provenance and the reasoning that admitted it |
| /learned log | Learning audit trail: admissions, retirements, reverts |
| /learned revert <id> | Take a learned item back — it stops reaching the agent |
| /learned correct <a> \| <b> \| <c> | Record a correction as an instruction: claim \| what would show it wrong \| what should improve |
| /brain run <agentId> | Manually enqueue a brain-agent run |
| /brain retry <jobId> | Re-arm a failed/cancelled brain job |
| /handover | Generate continuation note for next session |
| /explain <query> | Why recall returned what it did |
| /failed [area] | Past failed attempts for a problem area |
| /verify <id> [status] | Re-verify a memory record |
| /audit | Recent memory audit log |
| /export [path] | Dump memory + evidence + ops to JSON |
| /import <path> | Import a BrainRouter memory envelope |
| /persona | Show active Core Identity; subcommands: refresh, on, off, <name> |
| /skill-hints <skill> <hints> | Register extraction hints |
| /diagnostics | Scrubbed runtime + DB stats bundle |

## Workflows & Skills

| Command | Description |
|---------|-------------|
| /spec <title> | Produce spec.md (spec-driven-skill) |
| /feature-dev <feat> | Multi-agent feature dev with spec + tasks |
| /grill-me [--force] <task> | Clarify 2–5 questions before implementing (CLARIFY mode) |
| /review [scope] [--fix] | Multi-agent code review → review.md; --fix applies + verifies surviving fixes |
| /reviews [job-id] | List organization reviews or inspect durable coverage, evidence, and verifier state |
| /simplify [scope] [--dry-run] | Behavior-preserving code-simplification pass; --dry-run proposes only |
| /implement-plan | Execute next plan item; append walkthrough |
| /approve [slug] | Approve workflow + kick off implementation |
| /requirement create <title> \| list \| show <id> \| ask <id> <q> \| answer <id> <i> <a> \| clarify <id> \| seed-plan <id> \| update <id> --status/--priority/--criteria | Structured requirement records anchored to a session (status, priority, acceptance criteria, clarifying Q&A) |
| /track board \| list [text] \| create <title> [--type --status --priority] \| move <key> <status> \| show <key> | Track mode — the per-workspace project board (work items by status, one project per workspace) |
| /annotation add <kind> <id> <body> \| list \| show <id> \| status <id> <s> \| export | Durable feedback records (alias /annot): anchor to plans/reqs/files/diffs/findings, suggest code, export to markdown |
| /artifact create <kind> <title> \| list \| show <id> \| update <id> --status <s> | Durable workflow artifacts (alias /art): design notes, prototypes, reports, review exports — linked to requirement/session/memory |
| /diagram <kind> <what…> \| validate <file> \| render <file> [--slug s] [--theme t] \| list \| show <slug> \| open <slug> | Typed, validated system maps (architecture, workflow, sequence, dataflow, lifecycle) rendered to self-contained HTML with a receipt under .brainrouter/diagrams/ |
| /attach <path> \| list \| show <id> | Attach a file (PDF/image/text/code) to this session (alias /upload) — preserves the original, extracts text/metadata, captures to memory |
| /workflows [slug] | List durable workflows with live run progress; <slug> drills into the step timeline |
| /workflow run <template> [jsonArgs] | Explicitly authorize and launch one CLI workflow run (templates: compare, review-wide, research, build, investigate) |
| /workflow switch <slug> | Refocus on an existing workflow (migrates any session goal into the target) |
| /workflow pause | Pause the current workflow's goal |
| /workflow resume <slug> | Switch to <slug> AND resume its goal in one shot |
| /skill <name> [input] | Run any catalogued skill |
| /skills | List installed BrainRouter skills |
| /reload-skills | Force a re-scan of the skill directories |
| /plan /plan clear | Show the durable CLI task plan; clear it (drops stale items) |
| /planner [add\|list\|done] | Capture, list, and complete items in your personal planner |
| /tools | List local + MCP tools available to the agent |
| /goal [text\|clear\|complete\|pause\|resume\|budget <n>] | Sticky goal |
| /continue | Resume after a loop-limit abort |
| /loop <interval> <prompt> /loop stop | Repeat a prompt on cadence |
| /schedule cron "<expr>" <cmd> · /schedule in 5m <cmd> | Schedule a recurring (cron) or one-shot command |
| /playbook run <name> --param k=v · /playbook init\|list\|schedule | Run a parameterized, schedulable automation unit |
| /commit | Generate message, stage, and git commit |
| /diff | Show git changes (stream-paginated) |

## Multi-Agent Orchestration

| Command | Description |
|---------|-------------|
| /roles | List available agent roles |
| /agents [--json] | List local child-agent sessions in this CLI. |
| /agents tree | Spawn hierarchy (parent → children) with role + status glyphs. |
| /agents why <id> | Why a child exists: role, task, spawner, usage. |
| /agents transcript <id> [--tools] [--errors] | A child's transcript, optionally filtered to tool calls / errors. |
| /agents replay <id> | Numbered, read-only step-through of a child's run. |
| /agents --remote [--watch] [--usage] [--include-stale] [--json] | List federated peer CLIs / hosts attached to the same brain (0.4.0 Stage 2). |
| /workers [list\|info <id>\|close <id>] | Persistent worker threads in this CLI. |
| /pack [list\|enable <n>\|disable <n>\|info <n>] | Agent-definition packs (bundled custom agents). |
| /dm <sessionKey> <message> | Send text to one federated peer; recipient sees a banner above their next prompt (0.4.0 Stage 3). |
| /broadcast [<clientKind>:*] <message> | Send text to every active peer under your userId, or narrow to one clientKind. |
| /inbox [--peek] [--all] | Read this session’s inbox on demand; marks messages delivered unless --peek (0.4.0 Stage 3). |
| /handoff <target\|<kind>:next-idle> [note] | Hand your current goal + context to another session (0.4.1 Stage 4). |
| /handoff list \| accept [fromPrefix] | List / adopt an inbound goal handoff. |
| /agent <id> [--full] | Detail + recent transcript of a child |
| /spawn <role> <prompt> | Spawn a child agent |
| /build <task> | Explicitly authorize and launch the CLI build loop: plan → implement → verify → review |
| /wait <id> [ms] | Wait for a child to finish |
| /kill <agent-id> | Stop a running child |
| /auto-review [on\|off] | Auto-run reviewer after every worker (alias for /auto-chain review\|off) |
| /review-auto [--threshold N] [--scope <glob>] | Confidence-scored review fan-out: reviewer roster, deduped findings above threshold |
| /auto-chain [review\|verify\|both\|off] | Auto-chain review/verify follow-ups after every worker |
| /delegation-policy [auto\|ask-before-spawn\|ask-before-write-child\|no-children] | Gate whether/when the agent may spawn child agents |
| /bg <prompt> | Run a prompt in a detached background worker (manage via /workers, /ps) |
| /ps | List all background tasks (loop + workflows + workers + child agents) |
| /fg <id> | Bring a background worker/child agent to the foreground (snapshot of status + transcript) |
| /stop [id] | Stop a specific worker/child by id, or (no id) stop the loop + mark stale children |
| /queue [remove <n>\|clear] | View / manage messages you typed while a turn was running (they run next, in order) |
| /steer <message> | Apply a message to the active turn at its next safe model boundary |

## Guardrails & Permissions

| Command | Description |
|---------|-------------|
| /permissions [read\|write\|shell] | View or set agent access mode |
| /recent-denials [n] | List the last N tool denials (tool + reason + time) this session |
| /mode [planning\|fast] | Session execution stance (planning asks, fast skips per-call y/N for safe commands) |
| /review-policy [request\|proceed] | How the agent treats multi-file approval gates |
| /yolo [on\|off] | Alias for `/mode fast` + `/review-policy proceed` |
| /sandbox [status\|add-read\|add-write\|remove\|clear] | Sandbox grants |
| /hooks [list\|add\|remove\|enable\|disable] | Lifecycle shell hooks |
| /hookify [list\|create\|enable\|disable\|remove] | Markdown rule guards |
| /logout | Clear API keys from the active profile |

## Observability

| Command | Description |
|---------|-------------|
| /tokens | Session token usage + memory-savings estimate |
| /usage | Per-actor token breakdown — parent vs each child agent, cache hit, offload savings |
| /context [all\|current] | Context-window fill (used/max/%) + token breakdown: per-skill + per-briefing + per-tool calls |
| /watch | Tail trace log (BRAINROUTER_TRACE_LOG required) |
| /trace save <desc> /trace search <q> | Debug-trace store |
| /transcript [main\|sessionKey] | Recent persisted transcript |
| /rollout | Print the transcript file path |
| /debug-config | Show config layers, env, preferences |

## UI & Ergonomics

| Command | Description |
|---------|-------------|
| /theme [auto\|light\|dark\|mono] | Markdown output theme |
| /title <segments> | Terminal title (model,session,branch,mode) |
| /statusline <segments> | Prompt (mode,exec,effort,branch,dirty,model,tokens,session,pr,workflow,phase,goal,plan) |
| /personality [workspace\|global] <style> | Chat override by default; workspace/global persist. auto \| concise \| standard \| detailed \| pair-programmer |
| /effort [low\|medium\|high\|xhigh] | Reasoning depth: low=terse, medium=default, high=step-by-step, xhigh=maximum (alias: max) |
| /tier [name] | Show or pin the model tier on the provider's tier ladder |
| /model [auto\|bare\|provider/model] [--session] | List or switch the session model request; router mode uses the unified catalog |
| /profile [list\|use <name>\|save <name>\|delete <name>] | Named LLM profiles (cli.llmProfiles) — saved model/endpoint/effort presets; save snapshots the session; with 2+ profiles the agent gets a switch_model tool |
| /raw [on\|off] | Toggle raw scrollback |
| /quiet [on\|off] | Hide recall tables, previews, briefings (model prose only) |
| /vim | Toggle vi-mode for the composer |
| /keymap [json] | Show built-in bindings and set overrides |
| /copy | Copy last assistant response to clipboard |
| /mention [partial] | Suggest files for @ mentions |
| /mcp [list\|reconnect\|tools] | MCP profiles, identity tags, online/offline status, reconnect, tool namespaces |
| /ide | Show detected IDE host |
| /apps /plugins | List workspace skills and plugin folders |
| /plugin [init\|install\|list\|info\|enable\|disable\|remove\|validate] | Manage plugins — bundle skills/agents/commands/hooks/mcp/connectors/workflows into a named, installable unit (also: brainrouter plugin ...) |
| /marketplace [add\|remove\|list\|update] | Plugin marketplaces — register git/local/http sources, then install plugins by name across them (also: brainrouter marketplace ...) |
| /feedback [message] | Append feedback entry |
| /experimental [on\|off] | Toggle experimental features |
| /release-notes [version\|list] | Show changelog for current (or specified) CLI version |

## Undocumented

None — every slash command has a help entry.

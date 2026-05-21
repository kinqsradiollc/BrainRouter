# BrainRouter CLI Multi-Agent Implementation Plan

## Overview

BrainRouter CLI currently runs one interactive agent loop with local file tools, shell execution after confirmation, MCP tool passthrough, and best-effort memory recall/capture. To compete with Claude Code, Codex, and OpenClaw-style agent workflows, the CLI needs a real orchestration layer: durable sessions, explicit task planning, child-agent lifecycle management, role-scoped prompts, background execution, and inspectable status.

This plan is intentionally source-driven. It is based on the current `brainrouter/src` CLI implementation and local references under `openSrc/`, especially OpenClaw's subagent/session/tool architecture and Claude Code's public plugin command patterns.

## Current State

The current CLI package lives in `brainrouter/`.

- `brainrouter/src/index.ts` exposes `chat`, `login`, and `config`.
- `brainrouter/src/repl.ts` implements one blocking REPL turn at a time and slash commands such as `/tools`, `/doctor`, `/diff`, `/commit`, `/clear`, and `/compact`.
- `brainrouter/src/agent.ts` owns one agent loop, one `chatHistory`, local tools, MCP tool calls, recall injection, and passive turn capture.
- `brainrouter/src/systemPrompt.ts` tells the model to behave as a terminal coding agent, but there is no runtime-enforced planner or subagent system.
- `brainrouter/src/workspace.ts` resolves a single workspace root.

The current CLI therefore has useful foundations, but no durable multi-agent primitive.

## Reference Findings

### OpenClaw

OpenClaw treats agents as persistent session records rather than one-off prompt decorations.

Relevant local source:

- `openSrc/openclaw/src/agents/subagent-registry.ts`
- `openSrc/openclaw/src/agents/subagent-registry.types.ts`
- `openSrc/openclaw/src/agents/subagent-spawn.ts`
- `openSrc/openclaw/src/agents/tools/sessions-spawn-tool.ts`
- `openSrc/openclaw/src/agents/tools/sessions-list-tool.ts`
- `openSrc/openclaw/src/agents/tools/sessions-send-tool.ts`
- `openSrc/openclaw/src/agents/tools/update-plan-tool.ts`
- `openSrc/openclaw/src/agents/run-wait.ts`
- `openSrc/openclaw/qa/scenarios/agents/subagent-fanout-synthesis.md`

Patterns to borrow:

- Keep subagent runs in a registry with status, parent session, child session, labels, lifecycle timestamps, and completion metadata.
- Expose orchestration as tools: spawn, list, send, wait/yield, status, and update plan.
- Make fanout synthesis testable: verify that child sessions actually spawned, not merely that the parent narrated delegation.
- Persist run state so crashed or resumed sessions can recover outstanding work.
- Support liveness, timeout, orphan cleanup, and readable status.

### Claude Code Public Repo

The local `openSrc/claude-code` repo is mostly plugins/docs/changelog, not the full CLI implementation. It still reveals product-level requirements.

Relevant local source:

- `openSrc/claude-code/plugins/feature-dev/commands/feature-dev.md`
- `openSrc/claude-code/CHANGELOG.md`

Patterns to borrow:

- Feature development uses dedicated explorer, architect, and reviewer agents.
- Background sessions have explicit listing, resume, elapsed time, parent/child trace metadata, and awaiting-input status.
- Subagents need model/permission/MCP setting inheritance.
- The parent must synthesize child outputs rather than blindly trust child completion.

### agentmemory

The `openSrc/agentmemory` CLI is less relevant to orchestration, but useful for install/doctor/onboarding discipline.

Relevant local source:

- `openSrc/agentmemory/src/cli.ts`

Patterns to borrow:

- First-run onboarding and `doctor` should validate installation, runtime flags, and integration status.
- Diagnostic commands should offer dry-run/fix flows instead of only printing failures.

## Architecture Decisions

### 1. Add an Orchestrator Above `Agent`

Keep `Agent` as the unit that can run one conversation. Add a new orchestration layer responsible for creating and tracking many agents.

New modules:

- `brainrouter/src/sessionStore.ts`
- `brainrouter/src/taskStore.ts`
- `brainrouter/src/agentRoles.ts`
- `brainrouter/src/orchestrator.ts`
- `brainrouter/src/orchestratorTools.ts`

### 2. Make Planner State Durable

Add an explicit plan model stored under `.brainrouter/cli/` inside the workspace:

```text
.brainrouter/cli/
  sessions.json
  tasks.json
  transcripts/
    <session-id>.jsonl
```

This avoids hiding important state inside volatile `chatHistory`.

### 3. Expose Multi-Agent Control as Local Tools

The parent agent should be able to call orchestration tools the same way it calls file tools.

Initial local orchestration tools:

- `update_plan`
- `spawn_agent`
- `send_agent_message`
- `wait_agent`
- `list_agents`
- `read_agent_transcript`
- `close_agent`

These should be local CLI tools first. They can later be mirrored as MCP tools if useful.

### 4. Role-Scoped Agents

Start with a small built-in role registry:

- `explorer`: read-only codebase investigation; returns findings and key files.
- `architect`: design alternatives and tradeoffs; no file writes.
- `reviewer`: code review stance; findings first.
- `worker`: implementation-focused; can edit files if the parent grants write mode.
- `verifier`: runs tests or checks and reports failures.

Each role gets a role prompt overlay plus inherited workspace instructions, memory context, model config, and MCP server config.

### 5. Keep Permissions Conservative

Child agents should default to read-only. Write access should be explicit per spawn request.

Initial access modes:

- `read`: read/search/list only.
- `write`: read plus `write_file`/`edit_file`.
- `shell`: write plus `run_command` after confirmation.

Worktree isolation can come after the first vertical slice. It is important, but adding it before basic lifecycle/state exists would make the first implementation too broad.

### 6. Make CLI Status Inspectable

Add slash commands:

- `/plan`
- `/agents`
- `/agent <id>`
- `/spawn`
- `/wait`
- `/transcript <id>`

The LLM tools and human slash commands should read the same session/task store.

## Task List

### Phase 1: Durable Plan and Session Foundation

#### Task 1.1: Add CLI State Directory Helpers

**Description:** Add a small state module that resolves `.brainrouter/cli`, creates required directories, and reads/writes JSON safely.

**Acceptance criteria:**

- [ ] State paths are always inside the workspace root.
- [ ] Missing state files are treated as empty state.
- [ ] Writes are atomic enough for one CLI process.

**Verification:**

- [ ] `npm test -w brainrouter`

**Files likely touched:**

- `brainrouter/src/sessionStore.ts`
- `brainrouter/src/taskStore.ts`
- `brainrouter/src/agent.test.ts`

**Estimated scope:** S

#### Task 1.2: Add Plan Store and `update_plan` Local Tool

**Description:** Implement a durable task list with statuses and expose it to the parent agent as a local tool.

**Acceptance criteria:**

- [ ] Parent agent can create/update a plan during a turn.
- [ ] `/plan` displays the current persisted plan.
- [ ] Invalid statuses are rejected.

**Verification:**

- [ ] Unit tests for plan updates and slash rendering.
- [ ] `npm test -w brainrouter`

**Files likely touched:**

- `brainrouter/src/taskStore.ts`
- `brainrouter/src/agent.ts`
- `brainrouter/src/repl.ts`
- `brainrouter/src/systemPrompt.ts`

**Estimated scope:** M

#### Task 1.3: Add Transcript Persistence for the Main Agent

**Description:** Persist user, assistant, and tool messages to JSONL so the CLI can inspect and resume context later.

**Acceptance criteria:**

- [ ] Main session writes transcript entries after every turn.
- [ ] `/transcript main` prints recent transcript entries.
- [ ] Sensitive API keys are redacted before writing.

**Verification:**

- [ ] Unit tests cover transcript append and redaction.
- [ ] `npm test -w brainrouter`

**Files likely touched:**

- `brainrouter/src/sessionStore.ts`
- `brainrouter/src/agent.ts`
- `brainrouter/src/repl.ts`

**Estimated scope:** M

### Phase 2: Subagent Runtime

#### Task 2.1: Add Agent Role Registry

**Description:** Define built-in roles and role-specific prompt overlays.

**Acceptance criteria:**

- [ ] Roles are listable from code and slash command output.
- [ ] Unknown role names fail with a clear error.
- [ ] Role prompts inherit workspace instructions and runtime context.

**Verification:**

- [ ] Unit tests for role resolution and prompt construction.
- [ ] `npm test -w brainrouter`

**Files likely touched:**

- `brainrouter/src/agentRoles.ts`
- `brainrouter/src/systemPrompt.ts`
- `brainrouter/src/agent.test.ts`

**Estimated scope:** S

#### Task 2.2: Add Orchestrator Session Registry

**Description:** Track child agent sessions with parent ID, role, status, prompt, timestamps, and final result.

**Acceptance criteria:**

- [ ] Registry can create, update, list, and close sessions.
- [ ] Completed, failed, and running statuses are represented.
- [ ] Registry is persisted under `.brainrouter/cli/sessions.json`.

**Verification:**

- [ ] Unit tests for lifecycle transitions.
- [ ] `npm test -w brainrouter`

**Files likely touched:**

- `brainrouter/src/orchestrator.ts`
- `brainrouter/src/sessionStore.ts`
- `brainrouter/src/agent.test.ts`

**Estimated scope:** M

#### Task 2.3: Implement `spawn_agent`, `list_agents`, and `wait_agent`

**Description:** Allow the parent agent to launch bounded child agent work and wait for completion.

**Acceptance criteria:**

- [ ] `spawn_agent` starts a child agent with a role and prompt.
- [ ] `list_agents` shows current child sessions.
- [ ] `wait_agent` returns child status and final output or timeout.
- [ ] Parent turn can continue while children run.

**Verification:**

- [ ] Tests with a mock LLM runner prove at least two child agents can run and be synthesized.
- [ ] `npm test -w brainrouter`

**Files likely touched:**

- `brainrouter/src/orchestrator.ts`
- `brainrouter/src/orchestratorTools.ts`
- `brainrouter/src/agent.ts`
- `brainrouter/src/repl.ts`

**Estimated scope:** M

#### Task 2.4: Add `/agents`, `/agent`, `/spawn`, and `/wait`

**Description:** Give humans direct visibility and control over child sessions.

**Acceptance criteria:**

- [ ] `/agents` lists child sessions with status, role, label, and elapsed time.
- [ ] `/agent <id>` prints detail and last transcript lines.
- [ ] `/spawn <role> <prompt>` creates a child session.
- [ ] `/wait <id>` waits for a child and prints result.

**Verification:**

- [ ] Unit tests for command parsing where possible.
- [ ] Manual CLI smoke test with a local mock endpoint.

**Files likely touched:**

- `brainrouter/src/repl.ts`
- `brainrouter/src/orchestrator.ts`

**Estimated scope:** M

### Phase 3: Workflow Commands

#### Task 3.1: Add `/feature-dev`

**Description:** Implement a guided multi-agent feature-development workflow inspired by Claude Code's `feature-dev` plugin.

**Acceptance criteria:**

- [ ] Creates a plan with discovery, exploration, architecture, implementation, and review phases.
- [ ] Spawns explorer agents for codebase context.
- [ ] Requires user confirmation before implementation when the plan is not already approved.

**Verification:**

- [ ] Unit test confirms command creates the expected plan and explorer prompts.
- [ ] Manual smoke verifies the parent reads explorer outputs before proceeding.

**Files likely touched:**

- `brainrouter/src/repl.ts`
- `brainrouter/src/orchestrator.ts`
- `brainrouter/src/taskStore.ts`

**Estimated scope:** M

#### Task 3.2: Add `/review` Multi-Agent Review

**Description:** Run reviewer agents with separate focus areas and synthesize findings.

**Acceptance criteria:**

- [ ] Spawns reviewers for correctness, maintainability, and convention/test coverage.
- [ ] Aggregates findings in severity order.
- [ ] Does not auto-edit unless the user asks.

**Verification:**

- [ ] Mock child results are synthesized correctly.
- [ ] Manual smoke on a branch diff.

**Files likely touched:**

- `brainrouter/src/repl.ts`
- `brainrouter/src/orchestrator.ts`

**Estimated scope:** M

#### Task 3.3: Add `/implement-plan`

**Description:** Let the CLI execute the next unchecked plan item through a worker + verifier loop.

**Acceptance criteria:**

- [ ] Picks exactly one pending task by default.
- [ ] Spawns a worker for implementation and a verifier for tests/checks.
- [ ] Marks task complete only after verification succeeds.

**Verification:**

- [ ] Unit tests for task selection and status transitions.
- [ ] Manual smoke on a tiny fixture repo.

**Files likely touched:**

- `brainrouter/src/repl.ts`
- `brainrouter/src/taskStore.ts`
- `brainrouter/src/orchestrator.ts`

**Estimated scope:** M

### Phase 4: Isolation and Recovery

#### Task 4.1: Add Optional Git Worktree Isolation

**Description:** Allow write-mode child agents to work in isolated git worktrees when requested.

**Acceptance criteria:**

- [ ] Spawn options support `isolation: "none" | "worktree"`.
- [ ] Worktree path is deterministic and under a safe local state directory.
- [ ] Existing dirty worktree is not modified by isolated workers.

**Verification:**

- [ ] Unit tests for path safety.
- [ ] Manual git worktree smoke.

**Files likely touched:**

- `brainrouter/src/orchestrator.ts`
- `brainrouter/src/workspace.ts`
- `brainrouter/src/repl.ts`

**Estimated scope:** M

#### Task 4.2: Add Recovery and Cleanup

**Description:** Recover interrupted sessions and clean stale child sessions.

**Acceptance criteria:**

- [ ] CLI startup reconciles sessions marked running without an active promise.
- [ ] `/agents` shows stale/crashed sessions clearly.
- [ ] `/agent close <id>` closes a child without deleting transcript history.

**Verification:**

- [ ] Unit tests for stale session recovery.
- [ ] Manual interrupt/restart smoke.

**Files likely touched:**

- `brainrouter/src/orchestrator.ts`
- `brainrouter/src/sessionStore.ts`
- `brainrouter/src/repl.ts`

**Estimated scope:** M

### Phase 5: Diagnostics and Polish

#### Task 5.1: Extend `/doctor`

**Description:** Validate CLI state, transcript directory, configured model, MCP tool surface, and multi-agent readiness.

**Acceptance criteria:**

- [ ] `/doctor` reports plan store, session store, transcript directory, MCP connection, and orchestration tool availability.
- [ ] Failures include actionable text.

**Verification:**

- [ ] Manual `/doctor` smoke.
- [ ] `npm test -w brainrouter`

**Files likely touched:**

- `brainrouter/src/repl.ts`
- `brainrouter/src/sessionStore.ts`

**Estimated scope:** S

#### Task 5.2: Add Documentation

**Description:** Document multi-agent CLI usage and limitations.

**Acceptance criteria:**

- [ ] `brainrouter/README.md` includes `/plan`, `/agents`, `/feature-dev`, `/review`, and `/implement-plan`.
- [ ] Documentation states default child-agent permissions and worktree isolation behavior.

**Verification:**

- [ ] Documentation examples match CLI command names.

**Files likely touched:**

- `brainrouter/README.md`

**Estimated scope:** S

## Acceptance Criteria for Full Integration

- [ ] The CLI can maintain a durable plan across turns.
- [ ] The parent agent can spawn at least two child agents and synthesize their outputs.
- [ ] Child sessions are visible to the human through `/agents`.
- [ ] Child transcripts are persisted and inspectable.
- [ ] Failed/stale child sessions are recoverable or clearly marked.
- [ ] Multi-agent workflows exist for feature development, code review, and task execution.
- [ ] Tests prove that real tool calls created child sessions; narration alone is not enough.
- [ ] `npm test -w brainrouter` passes.
- [ ] Root `npm test` passes before marking the full feature complete.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Child agents edit the same files concurrently | High | Default child agents to read-only; add explicit write mode and later worktree isolation. |
| Parent agent over-delegates trivial tasks | Medium | System prompt should say delegation is for bounded parallel work, not every action. |
| Background child sessions hang | High | Add timeout, status, stale recovery, and `/wait` result states early. |
| Transcript files leak secrets | High | Redact API keys before persistence and tests should cover redaction. |
| Too much state lives only in memory | High | Persist sessions, tasks, and transcripts in Phase 1 before child execution. |
| Implementation becomes too large | Medium | Keep each phase testable and stop after each checkpoint if verification fails. |

## Recommended Next Step

Start with Phase 1. It adds durable plan/session foundations without changing agent behavior too much. After that, Phase 2 can introduce child agents as a controlled vertical slice.

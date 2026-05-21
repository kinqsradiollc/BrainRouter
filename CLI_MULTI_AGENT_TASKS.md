# BrainRouter CLI Multi-Agent Task Tracker

## Phase 1: Durable Plan and Session Foundation

- [x] Task 1.1: Add CLI state directory helpers
- [x] Task 1.2: Add plan store and `update_plan` local tool
- [x] Task 1.3: Add transcript persistence for the main agent

## Phase 2: Subagent Runtime

- [x] Task 2.1: Add agent role registry
- [x] Task 2.2: Add orchestrator session registry
- [x] Task 2.3: Implement `spawn_agent`, `list_agents`, and `wait_agent`
- [x] Task 2.4: Add `/agents`, `/agent`, `/spawn`, and `/wait`

## Phase 3: Workflow Commands

- [x] Task 3.1: Add `/feature-dev`
- [x] Task 3.2: Add `/review` multi-agent review
- [x] Task 3.3: Add `/implement-plan`

## Phase 4: Isolation and Recovery

- [ ] Task 4.1: Add optional git worktree isolation
- [ ] Task 4.2: Add recovery and cleanup

## Phase 5: Diagnostics and Polish

- [x] Task 5.1: Extend `/doctor`
- [x] Task 5.2: Add documentation

## Current Decision

Use the current `brainrouter/` package as the CLI package. Add a local orchestration layer before any MCP-side changes. The first implementation checkpoint should be Phase 1 only.

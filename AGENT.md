# BrainRouter Development Manual

**AGENT INSTRUCTION:** This is your primary instruction hub for developing, maintaining, and building the **BrainRouter** repository. You are the AI engineer building BrainRouter, not a client using its MCP server. 

> **Audience**: AI Coding Agents and Developers building BrainRouter.

---

## ⚖️ Core Development Rules

- **No MCP Tool Calling for Development**: Since we are the ones building BrainRouter, do NOT attempt to invoke `mcp_brainrouter_*` tools. Instead, perform all tasks locally using file system tools and local terminal commands.
- **Reference the `skills/` Folder Directly**: To maintain premium engineering workflow discipline, check the `skills/` folder directly using filesystem tools (`view_file`, `grep_search`). If a task matches a skill (e.g., `planning-skill`, `spec-driven-skill`, `debugging-and-error-recovery`), read its `SKILL.md` directly and follow its steps.
- **openSrc/ Reference Habit**: If the optional `openSrc/` folder is present, inspect it for mature patterns, open-source layouts, or CLI structures to draw ideas and code architecture designs from.
- **Incremental & Test-Driven**: When working on BrainRouter packages, dashboard, CLI, or MCP servers, write/update tests first and run the local test suites to prevent regressions.

---

## 📂 Codebase Directory Map

- **`skills/`**: Universal skill workflows and markdown definitions (organized by category: `agent`, `api`, `codebase`, `design`, `devops`, `lifecycle`, `memory`, `qa`, `ux`).
- **`brainrouter-cli/`**: Node.js/TypeScript CLI interface for working with local session memories and skills.
- **`dashboard/`**: React/Vite/Next.js dashboard for visualizing cognitive graphs, recall histories, and memory states.
- **`brainrouter/`**: Model Context Protocol (MCP) server implementations and tool definitions — the BrainRouter core (memory engine + tool registry).
- **`packages/`**: Shared core utility libraries and modules.
- **`openSrc/`** *(Conditional)*: Optional repository of open-source projects. Check this directory for reference patterns when creating new modules or refactoring existing ones.

---

## 🗺️ Scenario Mapping: Developing BrainRouter

When you are assigned a development task in this codebase, look up the scenario below and read the corresponding skill file directly from the filesystem:

### 🔍 Scenario: Planning & Architecture
*Focus: Clarifying ambiguous requirements, creating specs, and defining tasks.*
- **[planning-skill](skills/agent/planning-skill/SKILL.md)**: Standard planning mode, tracking progress in `task.md`.
- **[spec-driven-skill](skills/agent/spec-driven-skill/SKILL.md)**: Creating specs under `docs/specs/` before writing core code.
- **[adr-skill](skills/agent/adr-skill/SKILL.md)**: Creating ADRs under `docs/decisions/` for major database or routing decisions.

### 💻 Scenario: Code Implementation & Cleanups
*Focus: Writing robust code, refactoring layers, and codebase cleanup.*
- **[incremental-skill](skills/lifecycle/incremental-skill/SKILL.md)**: Implementing features in small, vertical micro-slices.
- **[code-structure-cleanup](skills/codebase/code-structure-cleanup/SKILL.md)**: Cleaning structural entropy, removing dead code, and standardizing service layers.
- **[code-simplification](skills/codebase/code-simplification/SKILL.md)**: Refactoring complex routines for high comprehension speed.
- **[conventions-skill](skills/codebase/conventions-skill/SKILL.md)**: Checking import order, type annotations, and naming style.

### 🧪 Scenario: Testing, Debugging & QA
*Focus: Running test runners, browser test cases, and error recovery.*
- **[debugging-and-error-recovery](skills/agent/debugging-and-error-recovery/SKILL.md)**: Systematic Reproduce → Localize → Fix → Guard debugging.
- **[testing-skill](skills/api/testing-skill/SKILL.md)**: Writing Vitest/Jest unit and integration tests.
- **[browser-testing-skill](skills/qa/browser-testing-skill/SKILL.md)**: Inspecting and testing dashboard UI.

### 🚀 Scenario: Shipping & Handovers
*Focus: Creating changelogs, preparing rollouts, and documenting changes.*
- **[shipping-skill](skills/lifecycle/shipping-skill/SKILL.md)**: Pre-flight checklist before finishing tasks.
- **[changelog-generator](skills/lifecycle/changelog-generator/SKILL.md)**: Compiling structured release changelogs.
- **[handover-skill](skills/agent/handover-skill/SKILL.md)**: Summarizing accomplishments in `walkthrough.md`.

---

## ⚡ Development Workflow Checklists

### Phase 1: Planning
1. Create a `task.md` checklist in the workspace to track progress.
2. If the user request is ambiguous, draft a micro-specification file and get explicit user approval.
3. Review `openSrc/` code patterns if available to inform technical design choices.

### Phase 2: Execution
1. Implement in small, verifiable steps.
2. Run build scripts (`npm run build` or equivalent) and local tests after each significant change.
3. Write test cases for any new functionality added to `brainrouter-cli` or core packages.

### Phase 3: Handover & Walkthrough
1. Run linting and formatting suites to keep codebase clean.
2. Record all completed checklist items in `task.md`.
3. Generate a structured summary of changes in `walkthrough.md` for human review.

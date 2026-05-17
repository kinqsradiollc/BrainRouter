# BrainRouter Agent Context Router

**AGENT INSTRUCTION:** This is your primary navigation hub for working on the BrainRouter project itself. Do NOT scan the entire directory. Instead, identify the user's task below and load ONLY the specified Global Skill via `mcp_brainrouter_get_skill`, the reference via `mcp_brainrouter_get_reference`, or the listed local documentation file to minimize context noise.

---

## ⚖️ Core Rules

- **Memory-First Habit**: Before doing anything, you MUST call `mcp_brainrouter_resolve_session` passing the current workspace path and the **Conversation ID** (as the `suggestedKey` if present). Use the returned `sessionKey` UUID for all subsequent `recall`, `capture_turn`, and `search` operations to ensure session continuity.
- **Proactive Memory Retrieval**: If `memory_recall` returns insufficient context, you MUST call `mcp_brainrouter_memory_search` with specific keywords.
- **Skill Context Registration**: When loading or updating a skill, proactively call `mcp_brainrouter_memory_register_skill_hints` to ensure the memory engine knows what to extract.
- **Resolve Contradictions**: Periodically, especially when starting a new task, call `mcp_brainrouter_memory_contradictions` to check for and resolve any conflicting instructions or memories.
- **No Shortcuts**: Avoid "this is too small for a skill" or "I'll just quickly fix it" rationalization.

## 🔄 Execution Model

For every request:
1. **Resolve Session**: Proactively call `mcp_brainrouter_resolve_session` with your current workspace path and the **Conversation ID** (as `suggestedKey`) to get a standardized `sessionKey` UUID.
2. **Recall Context**: Call `mcp_brainrouter_memory_recall` using the resolved `sessionKey`. If the recalled context is missing key details, immediately call `mcp_brainrouter_memory_search`.
3. **Detect Intent**: Map the user's request to a scenario below using the recalled context. Check `mcp_brainrouter_memory_contradictions` if there is ambiguity.
4. **Select Skill**: Identify the most relevant skill name.
5. **Execute**: Fetch the skill using `mcp_brainrouter_get_skill`. If this is a newly invoked skill, call `mcp_brainrouter_memory_register_skill_hints`. Follow the skill workflow strictly.
6. **Record Outcome**: Call `mcp_brainrouter_memory_capture_turn` using the resolved `sessionKey` as your *final tool call* to persist the turn. Do NOT attempt to call this after your text response.
7. **Iterate**: Return to this router if the scenario changes (e.g., from Debugging to Shipping).

## 🗺️ Lifecycle Mapping
- **DEFINE** → `spec-driven-development` (Global Skill)
- **PLAN** → `planning-and-task-breakdown` (Global Skill)
- **BUILD** → `incremental-implementation` (Global Skill) + `testing-skill` (Global Skill)
- **REVIEW** → `code-reviewer` (Global Persona) + `code-review-and-quality` (Global Skill)
- **HANDOVER** → `project-handover-and-walkthrough` (Global Skill)
- **SHIP** → `shipping-and-launch` (Global Skill)

---

## 🏗️ Scenario: MCP Server Development
*Focus: Tools, registry, loaders, and stdio/HTTP transports.*
- **Core Codebase**: Code lives in `mcp/src/` (not `src/`).
- **`api-skill`**: For middleware and server logic, though adapted for MCP concepts.
- **`conventions-skill`**: Standardized TypeScript and formatting rules for the codebase.

## 🧠 Scenario: Memory Engine Development
*Focus: Evolving BrainRouter with a hierarchical memory subsystem.*
- **Core Requirement**: The engine must be **multi-tenant**, supporting many users on a single server. Memories must be isolated by `user_id` or equivalent, not just session keys.
- **LLM Abstraction**: Extraction requires an LLM. Implement this as a configurable OpenAI-compatible endpoint rather than a hardcoded service.
- **`spec-driven-development`**: Mandatory before adding new memory layers (L0, L1, L1.5).
- **Architecture Base**: Reference the original concepts in `CONCEPT.md` and the refined target state in `APPLIED_CONCEPT.md` (keeping in mind the 5 required adjustments for BrainRouter's reality).

## 📚 Scenario: Skill & Content Authoring
*Focus: Writing, updating, and scaffolding skills, personas, and references.*
- **`skill-authoring`**: Canonical structure, format, and writing principles for BrainRouter SKILL.md files. Always use this when creating or modifying skills.
- **`doc-management-skill`**: Reading and maintaining the global registry files.

## 🧪 Scenario: QA, Testing & UX Friction
*Focus: Verification and tool robustness.*
- **`testing-skill`**: Unit and integration testing using Vitest (BrainRouter's test runner).
- **`testing-patterns`**: (Reference) Arrange-Act-Assert, mocking, and pattern testing. Use `mcp_brainrouter_get_reference(name: "testing-patterns")`.

## 🔍 Scenario: Debugging & Troubleshooting
*Focus: Root-Cause Analysis.*
- **`debugging-and-error-recovery`**: Systematic Reproduce → Localize → Fix → Guard process.
- **`api-layered-debugging`**: Connectivity and protocol flow, particularly for Streamable HTTP or stdio pipe issues.

## 🐳 Scenario: Infrastructure & DevOps
*Focus: Deployment, CI/CD, and scaling.*
- **`ci-cd-and-automation`**: Automated pipeline setup and quality gates.
- **`docker-lifecycle-engineering`**: Containerizing the HTTP transport mode for remote MCP server hosting.
- **`git-workflow-and-versioning`**: Branching strategy, commit standards, and version control hygiene.

## 📝 Scenario: Proposals & Decision Making
*Focus: Trade-off Analysis and Architectural Records.*
- **`documentation-and-adrs`**: Recording architectural decisions (ADRs) particularly for the Memory Engine.
- **`high-agency-communication`**: Standardized framework for technical proposals (1-3-1 Rule).

## 🔬 Scenario: Codebase Analysis & Exploration
*Focus: Understanding existing code, style, risks, and technical health.*
- **`conventions-skill`**: Naming patterns, formatting rules, import order, and module design standards.
- **`code-simplification`**: Reducing complexity while preserving behavior.
- **`code-review-and-quality`**: Multi-axis evaluation and quality gates.
- **`concerns-skill`**: Surfacing tech debt, known bugs, and security gaps.

## 🧠 Scenario: Agent Methodology & Planning
*Focus: Meta-cognition, requirement refining, and strict verification.*
- **`using-agent-skills`**: Meta-skill for skill discovery and operating behaviors.
- **`context-engineering`**: Systematic curation of agent context.
- **`interview-me`**: Proactive requirement gathering for underspecified tasks.
- **`doubt-driven-development`**: Adversarial self-review to disprove assumptions before implementation.
- **`source-driven-development`**: Mandatory verification against official framework documentation.
- **`idea-refine`**: Stress-testing raw concepts before committing to code.
- **`planning-and-task-breakdown`**: Systematic decomposition of complex features into tasks with active tracking via `task.md`.
- **`spec-driven-development`**: Creating technical specifications before writing a single line of logic.

## 🤖 Scenario: Specialized Expert Personas
*Focus: Adopting a specific role for deep analysis or fan-out orchestration.*
- **`code-reviewer`**: Staff Engineer persona for PR reviews.
- **`security-auditor`**: Security Engineer persona for vulnerability detection and threat modeling.
- **`test-engineer`**: QA Engineer persona for coverage analysis and test strategy.

## 🚀 Scenario: Lifecycle & Delivery
*Focus: Preparation, Migration, and Incremental Shipping.*
- **`shipping-and-launch`**: Pre-flight checklists and production rollout strategies.
- **`project-handover-and-walkthrough`**: Summarizing accomplishments and providing a `walkthrough.md` for human review.
- **`deprecation-and-migration`**: Safely sunsetting legacy code.
- **`incremental-implementation`**: Breaking large changes into manageable, reviewable PRs.

---

## 🎭 Orchestration: Skills, Personas, and Commands
BrainRouter uses three composable layers to manage complexity:

- **Skills** (Global MCP): Workflows with steps and exit criteria. The **How**.
- **Personas** (Global MCP): Roles with a specific perspective (e.g., Security Auditor). The **Who**.
- **Commands**: User-facing entry points (e.g., `/review`). The **When**.

**Composition Rule:** Personas do not invoke other personas. A persona may invoke global skills using `mcp_brainrouter_get_skill`.

### 🔀 Persona Decision Matrix
- **Invoke `code-reviewer`**: When conducting PR reviews (Correctness, Readability, Architecture, Security, Performance).
- **Invoke `security-auditor`**: When auditing sensitive flows or threat modeling new features.
- **Invoke `test-engineer`**: When defining test strategies or resolving QA gaps.

---

**QUICK LOAD COMMAND:**
Look up the required resource name for your scenario, then use the appropriate tool to load the instructions:
- **Skills**: `mcp_brainrouter_get_skill(name: "<skill-name>")`
- **References**: `mcp_brainrouter_get_reference(name: "<reference-name>")`
- **Personas**: `mcp_brainrouter_get_persona(name: "<persona-name>")`
- **Docs (Templates)**: `mcp_brainrouter_get_doc(name: "<doc-name>")`

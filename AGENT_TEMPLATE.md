# {{PROJECT_NAME}} Agent Context Router

<!--
  ╔══════════════════════════════════════════════════════════════════╗
  ║              BRAINROUTER · AGENT.MD TEMPLATE v3.0               ║
  ║                                                                  ║
  ║  HOW TO USE THIS TEMPLATE                                        ║
  ║  ─────────────────────────────────────────────────────────────  ║
  ║  1. Copy this file to your project root as AGENT.md             ║
  ║  2. Replace every {{PLACEHOLDER}} with your project details.    ║
  ║  3. Add / remove scenario blocks to match your tech stack.      ║
  ║  4. Delete this comment block when you're done.                 ║
  ║                                                                  ║
  ║  PLACEHOLDERS                                                    ║
  ║  ─────────────────────────────────────────────────────────────  ║
  ║  {{PROJECT_NAME}}      Human-readable project name              ║
  ║                        e.g. "Acme API", "VibeCoder Dashboard"   ║
  ║  {{DOCS_PATH}}         Relative path to your docs               ║
  ║                        e.g. "./docs"                             ║
  ║  {{API_DOC_PATH}}      Path to API spec or route contract       ║
  ║                        e.g. "./docs/api/API.md"                 ║
  ║  {{DESIGN_DOC_PATH}}   Path to design system or style guide     ║
  ║                        e.g. "./docs/design/DESIGN.md"           ║
  ║  {{DESIGN_STYLE}}      Short description of the design system   ║
  ║                        e.g. "minimalist warm-monochrome"         ║
  ║  {{STACK_DETAIL}}      Key stack callouts for the AI            ║
  ║                        e.g. "Next.js 14 App Router + Postgres"  ║
  ║  {{TEST_RUNNER}}       Test framework in use                    ║
  ║                        e.g. "Vitest", "Jest", "Playwright"      ║
  ║  {{EXTRA_SCENARIOS}}   (Optional) Paste custom blocks below     ║
  ║                        the standard scenario list               ║
  ╚══════════════════════════════════════════════════════════════════╝
-->

> **Stack**: {{STACK_DETAIL}}  
> **Audience**: Software Engineers, AI Engineers, and VibeCoders

**AGENT INSTRUCTION:** This is your primary navigation hub. Do NOT scan the entire `{{DOCS_PATH}}` directory. Instead, identify the user's task below and load ONLY the specified Global Skill via `mcp_brainrouter_get_skill`, the reference via `mcp_brainrouter_get_reference`, or the listed local documentation file to minimize context noise.

---

## ⚡ Quick Wins (Start Here)

These are the highest-value habits that immediately improve output quality on any project:

1. **Resolve session first** — always call `mcp_brainrouter_memory_resolve_session` before doing anything.
2. **Load, don't guess** — use `mcp_brainrouter_get_skill` instead of implementing from memory.
3. **Check local references** — if a reference-implementations directory exists in the workspace, scan it before writing novel code.
4. **Cite what you used** — call `mcp_brainrouter_memory_mark_cited` after every response to drive the ACE recall loop.
5. **Offload large outputs** — call `mcp_brainrouter_memory_working_offload` for any file, log, or diff exceeding 1,000 tokens.

---

## ⚖️ Core Rules

- **Skill-First Mindset**: If a task matches a skill, invoke it with `mcp_brainrouter_get_skill`. Never implement directly if a skill applies.
- **Memory-First Habit**: Before doing anything, call `mcp_brainrouter_memory_resolve_session` with the current workspace path and **Conversation ID** (as `suggestedKey`). Use the returned `sessionKey` for all subsequent memory operations.
- **Focus Pre-Warming & System Hints**: Treat instructions in `<skill-prewarm>` XML blocks with the same authority as skill documents. These are injected dynamically when skills cross the `0.3` activation threshold.
- **Short-Term Working Memory Offloads**: Call `mcp_brainrouter_memory_working_offload` for stdout, stderr, or files exceeding **1,000 tokens**. Monitor the Mermaid task canvas with `mcp_brainrouter_memory_working_context`.
- **Proactive Memory Retrieval**: If `mcp_brainrouter_memory_recall` returns insufficient context, call `mcp_brainrouter_memory_search` with specific keywords. Use `asOf` (ISO 8601) to query point-in-time state.
- **Citation Habit**: After generating a response, call `mcp_brainrouter_memory_mark_cited` with `citedRecordIds` (actually used) and `allRecalledRecordIds` (everything surfaced). Pass `citedRecordIds: []` if no memories were used.
- **Skill Registration**: When authoring or loading a new skill, register its hints via `mcp_brainrouter_memory_register_skill_hints` or the YAML `hints:` field.
- **Resolve Contradictions**: At the start of any new task, call `mcp_brainrouter_memory_contradictions` to surface conflicting instructions.
- **No Shortcuts**: Avoid "this is too small for a skill" or "I'll just quickly fix it" rationalization.
- **Local Reference Habit**: If a reference-implementations directory exists in the workspace, check it for open-source reference implementations before writing novel code. Use it to inform architecture — not to blindly copy.

---

## 🔄 Execution Model

For every request:
1. **Resolve Session**: Call `mcp_brainrouter_memory_resolve_session` with workspace path and Conversation ID to get a `sessionKey` UUID.
2. **Scan Pre-Warmed Hints**: Check the system prompt for `<skill-prewarm>` blocks and apply them immediately.
3. **Recall Context**: Call `mcp_brainrouter_memory_recall` with the `sessionKey`. For long-running tasks, fetch `mcp_brainrouter_memory_working_context` too. Capture the `recalledCognitiveRecords[].recordId` list.
4. **Detect Intent**: Map the request to a scenario below. Use `mcp_brainrouter_memory_contradictions` if there is ambiguity.
5. **Select Skill**: Identify the most relevant skill name.
6. **Execute & Offload**: Fetch the skill via `mcp_brainrouter_get_skill` (spikes its potential, delays decay). Register hints for newly loaded skills. Offload outputs exceeding 1,000 tokens.
7. **Signal Citations**: Call `mcp_brainrouter_memory_mark_cited` with `citedRecordIds` and `allRecalledRecordIds`.
8. **Record Outcome**: If passive hooks are not active, call `mcp_brainrouter_memory_capture_turn` as the final tool call.
9. **Iterate**: Return to this router if the scenario changes.

---

## 🗺️ Lifecycle Mapping

| Phase | Skill |
|-------|-------|
| **DEFINE** | `planning-skill` |
| **PLAN** | `planning-skill` |
| **BUILD** | `incremental-skill` + `testing-skill` |
| **REVIEW** | `code-reviewer` (Persona) + `code-review-and-quality` |
| **HANDOVER** | `handover-skill` |
| **SHIP** | `shipping-skill` |

---

## 🏗️ Scenario: Backend & API Development
*Focus: Security, auth, route design, and performance.*
- **[API Contract]({{API_DOC_PATH}})**: Source of truth for routes, schemas, and status codes.
- **`api-skill`**: Middleware, request validation, and route design patterns.
- **`auth-skill`**: Identity, session management, JWT rules, and token revocation.
- **`performance-skill`**: Caching strategies, {{STACK_DETAIL}} query optimization, and latency budgets.
- **`testing-skill`**: Unit and integration testing with {{TEST_RUNNER}} patterns.
- **`concerns-skill`**: Surface tech debt, security gaps, and latent risks in API code.

## 🎨 Scenario: Frontend & UI Development
*Focus: Design quality, component architecture, and performance.*
- **[Design System]({{DESIGN_DOC_PATH}})**: Design tokens ({{DESIGN_STYLE}}) and component rules.
- **`taste-skill`**: High-agency frontend engineering — variance dials, dependency checks, motion standards.
- **`soft-skill`**: Agency-level spatial rhythm, double-bezel cards, spring-physics transitions.
- **`redesign-skill`**: Audit-driven upgrades for existing projects without breaking functionality.
- **`a11y-skill`**: WCAG 2.1 AA accessibility mandates for all public-facing interfaces.
- **`concept-diagrams`**: Minimal flat SVG diagrams for architecture, flow, or data visualizations.

## 🧪 Scenario: QA, Testing & UX Friction
*Focus: Verification, coverage, and friction analysis.*
- **`testing-skill`**: Unit, integration, and E2E verification. {{TEST_RUNNER}} patterns and Arrange-Act-Assert.
- **`adversarial-ux-skill`**: Persona-based friction testing to surface user pain points pre-launch.
- **`browser-testing-skill`**: Real-time browser inspection, DOM analysis, and console debugging via MCP.

## 🔍 Scenario: Debugging & Troubleshooting
*Focus: Root-cause analysis and systematic recovery.*
- **`debugging-and-error-recovery`**: Systematic Reproduce → Localize → Fix → Guard process.
- **`concerns-skill`**: Identify hidden failure modes, leaky abstractions, and stale state bugs.

## 🐳 Scenario: Infrastructure & DevOps
*Focus: Containers, pipelines, networking, and version control.*
- **`docker-skill`**: Container lifecycle, Dockerfile best practices, and prune hygiene.
- **`ci-cd-skill`**: Automated pipeline setup, quality gates, and branch protection rules.
- **`domain-skill`**: Cloudflare Tunnel → Traefik → service routing patterns.
- **`git-workflow-skill`**: Branching strategy, commit standards, and version control hygiene.

## 📝 Scenario: Proposals & Decision Making
*Focus: Trade-off analysis and structured technical communication.*
- **`1-3-1-rule`**: Standardized framework for technical proposals and architectural decision memos.
- **`doc-management-skill`**: Recording architectural decisions (ADRs) and managing living documentation.

## 🔬 Scenario: Codebase Analysis & Exploration
*Focus: Understanding code, style, risks, and tech health.*
- **`conventions-skill`**: Naming patterns, formatting rules, import order, and module design standards.
- **`code-review-and-quality`**: Multi-axis evaluation — correctness, readability, architecture, security, performance.
- **`concerns-skill`**: Surface tech debt, known bugs, and security gaps.
- **`code-structure-cleanup`**: Structural entropy reduction — dead code, duplication, module cohesion.

> **Local Reference Tip**: If a reference-implementations directory is present, inspect it for canonical reference implementations relevant to the area being analyzed. Use it to calibrate conventions and code health expectations.

## 🧠 Scenario: Agent Methodology & Planning
*Focus: Metacognition, requirement gathering, and agentic discipline.*
- **`using-agent-skills`**: Meta-skill for skill discovery and correct operating behaviors.
- **`context-engineering`**: Systematic curation of agent context (rules, skills, docs, examples).
- **`interview-skill`**: Proactive requirement gathering for underspecified or ambiguous tasks.
- **`doubt-driven-skill`**: Adversarial self-review — disprove assumptions before committing to implementation.
- **`source-driven-skill`**: Mandatory verification against official documentation before using any framework API.
- **`idea-refine-skill`**: Structured pressure-testing of technical concepts before coding.
- **`planning-skill`**: Decompose complex requests into tasks with active tracking via `task.md`.
- **`agentic-engineering-workflow`**: End-to-end workflow skill for software/AI engineering tasks.

## 🧠 Scenario: Agent Memory & Continuity
*Focus: Persistent awareness, cross-session recall, and learning.*
- **`agent-memory`**: Mandatory skill for managing the memory engine lifecycle (Recall → Capture → Cite).
- `mcp_brainrouter_memory_search`: Deep retrieval. Pass `asOf` (ISO 8601) for point-in-time audits.
- `mcp_brainrouter_memory_graph_query`: Query GraphRAG — entities and relationships up to 2 hops away.
- `mcp_brainrouter_memory_mark_cited`: **Required after every response.** Drives ACE recall-ranking feedback.
- `mcp_brainrouter_memory_contradictions`: Surface and resolve conflicting instructions or past decisions.

## 🤖 Scenario: Specialized Expert Personas
*Focus: Adopting a specific role for deep analysis.*
- **`code-reviewer`**: Staff Engineer persona — 5-axis PR reviews (Correctness, Readability, Architecture, Security, Performance).
- **`security-auditor`**: Security Engineer persona — vulnerability detection, CVE triage, threat modeling.
- **`test-engineer`**: QA Engineer persona — coverage analysis, test strategy, and Prove-It tests.

## 🚀 Scenario: Lifecycle & Delivery
*Focus: Preparation, migration, and incremental shipping.*
- **`shipping-skill`**: Pre-flight checklists and production rollout strategies.
- **`handover-skill`**: Summarize accomplishments, produce `walkthrough.md` for human review.
- **`migration-skill`**: Safely sunset legacy code and migrate users to new implementations.
- **`incremental-skill`**: Break large changes into manageable, reviewable increments.
- **`changelog-generator`**: Auto-generate structured changelogs from commit history and task completions.

<!-- {{EXTRA_SCENARIOS}} — paste additional scenario blocks here -->

---

## 🎭 Orchestration: Skills, Personas, and Commands

{{PROJECT_NAME}} uses three composable layers:

- **Skills** (Global MCP): Workflows with steps and exit criteria. The **How**.
- **Personas** (Global MCP): Roles with a specific perspective. The **Who**.
- **Commands**: User-facing entry points (e.g., `/ship`, `/review`). The **When**.

**Composition Rule:** Personas do not invoke other personas. A persona may invoke global skills via `mcp_brainrouter_get_skill`.

### 🔀 Persona Decision Matrix

| Situation | Persona |
|-----------|---------|
| PR review or code quality gate | `code-reviewer` |
| Auth flows, CVE fixes, threat modeling | `security-auditor` |
| Coverage gaps, test strategy, QA planning | `test-engineer` |

---

## ⚡ Quick Load Commands

```
# Skills
mcp_brainrouter_get_skill(name: "<skill-name>")

# References
mcp_brainrouter_get_reference(name: "<reference-name>")

# Personas
mcp_brainrouter_get_persona(name: "<persona-name>")

# Template Docs
mcp_brainrouter_list_template_docs()
mcp_brainrouter_get_template_doc(name: "<doc-name>")
```

### Memory Tools — RAG / Long-Term

| Tool | Purpose |
|------|---------|
| `mcp_brainrouter_memory_recall` | Inject context at turn start. Returns `recalledCognitiveRecords[].recordId`. |
| `mcp_brainrouter_memory_mark_cited` | Signal citations after response. Required — drives ACE loop. |
| `mcp_brainrouter_memory_capture_turn` | Persist turn as final tool call (optional if passive hooks active). |
| `mcp_brainrouter_memory_search` | Deep retrieval. Supports `asOf` ISO param for point-in-time queries. |
| `mcp_brainrouter_memory_graph_query` | Query GraphRAG — entities + relationships up to 2 hops away. |
| `mcp_brainrouter_memory_contradictions` | Surface and resolve conflicting instructions. |

### Memory Tools — Working Memory / Context Reduction

| Tool | Purpose |
|------|---------|
| `mcp_brainrouter_memory_working_context` | Fetch Mermaid task canvas & state block. |
| `mcp_brainrouter_memory_working_offload` | Offload large payloads (>1,000 tokens). Returns nodeId. |
| `mcp_brainrouter_memory_working_reset` | Flush working memory for session. |

### Memory Tools — Software Engineering Workflow

| Tool | Purpose |
|------|---------|
| `mcp_brainrouter_memory_task_state` / `memory_task_update` | Structured progress tracking. |
| `mcp_brainrouter_memory_failed_attempts` | Query previously tried (and failed) solutions. |
| `mcp_brainrouter_memory_file_history` | Query memories tied to specific file paths. |
| `mcp_brainrouter_memory_debug_trace_save` / `_search` | Record and query bug reproduction traces. |
| `mcp_brainrouter_memory_handover` | Produce handover summary with evidence links. |
| `mcp_brainrouter_memory_verify` | Verify memory accuracy and adjust confidence score. |

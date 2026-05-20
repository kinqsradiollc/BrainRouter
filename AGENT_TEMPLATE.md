# {{PROJECT_NAME}} Agent Context Router

<!--
  ╔══════════════════════════════════════════════════════════════════╗
  ║              BRAINROUTER · AGENT.MD TEMPLATE v2.0               ║
  ║                                                                  ║
  ║  HOW TO USE THIS TEMPLATE                                        ║
  ║  ─────────────────────────────────────────────────────────────  ║
  ║  1. Copy this file to your project root as AGENT.md             ║
  ║  2. Replace every {{PLACEHOLDER}} with your project details.    ║
  ║  3. Add / remove scenario blocks to match your tech stack.      ║
  ║  4. Delete this comment block when you're done.                 ║
  ╚══════════════════════════════════════════════════════════════════╝

  PLACEHOLDERS:
  ─────────────
  {{PROJECT_NAME}}        → Human-readable project name  (e.g. "DateDrop")
  {{DOCS_PATH}}           → Relative path to your docs   (e.g. "./docs")
  {{API_DOC_PATH}}        → API docs path                (e.g. "./docs/api/API.md")
  {{DESIGN_DOC_PATH}}     → Design doc path              (e.g. "./docs/design/Design.md")
  {{DESIGN_STYLE}}        → Your design style/theme      (e.g. "Pinterest-style")
  {{STACK_DETAIL}}        → Key stack callouts           (e.g. "Redis + Postgres")
  {{EXTRA_SCENARIOS}}     → (Optional) Add custom blocks below the standard ones
-->

**AGENT INSTRUCTION:** This is your primary navigation hub. Do NOT scan the entire `{{DOCS_PATH}}` directory. Instead, identify the user's task below and load ONLY the specified Global Skill via `mcp_brainrouter_get_skill`, the reference via `mcp_brainrouter_get_reference`, or the listed local documentation file to minimize context noise.

---

## ⚖️ Core Rules

- **Skill-First Mindset**: If a task matches a skill, you MUST invoke it using the `mcp_brainrouter_get_skill` tool. Never implement directly if a skill applies.
- **Memory-First Habit**: Before doing anything, you MUST call `mcp_brainrouter_memory_resolve_session` passing the current workspace path and the **Conversation ID** (as the `suggestedKey` if present). Use the returned `sessionKey` UUID for all subsequent `mcp_brainrouter_memory_recall`, `mcp_brainrouter_memory_capture_turn`, and `mcp_brainrouter_memory_search` operations.
- **L2 Pre-Warming & System Hints**: Treat any instructions inside the `<skill-prewarm>` XML block in the system prompt with the same strict authority as the main skill documents. These are active guidelines injected dynamically because the corresponding skills crossed the `0.3` activation potential threshold.
- **Short-Term Working Memory Offloads**: Proactively call `mcp_brainrouter_memory_working_offload` for any stdout, stderr, or files exceeding **1,000 tokens** to prevent context window bloat. Use `mcp_brainrouter_memory_working_context` to monitor the Mermaid task canvas.
- **Proactive Memory Retrieval**: If `mcp_brainrouter_memory_recall` returns insufficient context, you MUST call `mcp_brainrouter_memory_search` with specific keywords. Use the optional `asOf` parameter (ISO 8601) to query what the memory engine knew at a specific point in time.
- **Citation Habit**: After generating your response, call `mcp_brainrouter_memory_mark_cited` with the `recordIds` you actually referenced (`citedRecordIds`) and the full list returned by the previous recall (`allRecalledRecordIds`). This powers the ACE feedback loop. Pass an empty `citedRecordIds` array if no memories were used.
- **Skill Context Registration**: When authoring, updating, or loading a new skill, register its metadata hints using `mcp_brainrouter_memory_register_skill_hints` (or specify them in the skill file's yaml frontmatter) so the L2 pre-warming engine can locate them.
- **Resolve Contradictions**: Periodically, especially when starting a new task, call `mcp_brainrouter_memory_contradictions` to check for and resolve any conflicting instructions or memories.
- **Strict Adherence**: Follow skill instructions exactly. Do not partially apply them or "skip ahead" to code.
- **No Shortcuts**: Avoid "this is too small for a skill" or "I'll just quickly fix it" rationalization.
 
## 🔄 Execution Model
 
For every request:
1. **Resolve Session**: Proactively call `mcp_brainrouter_memory_resolve_session` with your current workspace path and the **Conversation ID** (as `suggestedKey`) to get a standardized `sessionKey` UUID.
2. **Scan Pre-Warmed Hints**: Check your system prompt for any `<skill-prewarm>` tags. If instructions are present, apply them immediately to the current workspace task.
3. **Recall Context**: Call `mcp_brainrouter_memory_recall` using the resolved `sessionKey`. If in a long-running task, also fetch `mcp_brainrouter_memory_working_context` to view the task canvas. Capture the `recalledL1Memories[].recordId` list — you will need it in step 7.
4. **Detect Intent**: Map the user's request to a scenario below using the recalled context. Check `mcp_brainrouter_memory_contradictions` if there is ambiguity.
5. **Select Skill**: Identify the most relevant skill name.
6. **Execute & Offload**: Fetch the skill using `mcp_brainrouter_get_skill` (which spikes its potential by `+1.0` and delays its decay). If this is a newly invoked skill, ensure its hints are registered using `mcp_brainrouter_memory_register_skill_hints`. Follow the skill workflow strictly. Call `mcp_brainrouter_memory_working_offload` for any output exceeding 1,000 tokens.
7. **Signal Citations**: After generating your response, call `mcp_brainrouter_memory_mark_cited` with:
   - `citedRecordIds`: IDs of memories you actually referenced in your response
   - `allRecalledRecordIds`: the full `recalledL1Memories[].recordId` list from step 3
   - Pass an empty `citedRecordIds: []` if no specific memories were used
8. **Record Outcome**: If passive capturing hooks (e.g. Claude Code/Codex) are not running, call `mcp_brainrouter_memory_capture_turn` using the resolved `sessionKey` as your *final tool call* to persist the turn (which also acts as a potential spike trigger for related skills).
9. **Iterate**: Return to step 1 if the scenario changes or a new request arrives.

## 🗺️ Lifecycle Mapping
- **DEFINE** → `spec-driven-development` (Global Skill)
- **PLAN** → `planning-and-task-breakdown` (Global Skill)
- **BUILD** → `incremental-implementation` (Global Skill) + `testing-skill` (Global Skill)
- **REVIEW** → `code-reviewer` (Global Persona) + `code-review-and-quality` (Global Skill)
- **HANDOVER** → `project-handover-and-walkthrough` (Global Skill)
- **SHIP** → `shipping-and-launch` (Global Skill)

---

## 🏗️ Scenario: Backend & API Development
*Focus: Security, Auth, Performance, and Routes.*
- **[API Standards]({{API_DOC_PATH}})**: Absolute source of truth for routes and architecture.
- **`api-skill`**: Mandatory middleware and validation boilerplate.
- **`security-checklist`**: (Reference) Mandatory OWASP Top 10 and common vulnerability prevention. Use `mcp_brainrouter_get_reference(name: "security-checklist")`.
- **`auth-skill`**: Identity, JWT rules, and "Kill Switch" logic.
- **`performance-skill`**: {{STACK_DETAIL}} caching and replication rules.
- **`performance-checklist`**: (Reference) SQL optimization and caching best practices. Use `mcp_brainrouter_get_reference(name: "performance-checklist")`.

## 🎨 Scenario: Frontend & UI Development
*Focus: Aesthetics, Components, and Motion.*
- **[Design Language]({{DESIGN_DOC_PATH}})**: Design tokens ({{DESIGN_STYLE}}) and component rules.
- **`design-taste-frontend`**: High-end layout engineering and motion standards.
- **`soft-skill`**: High-end agency design standards (fonts, spacing, shadows).
- **`a11y-skill`**: WCAG 2.1 AA accessibility mandates for frontend.
- **`accessibility-checklist`**: (Reference) Semantic HTML and screen reader compliance. Use `mcp_brainrouter_get_reference(name: "accessibility-checklist")`.

## 🧪 Scenario: QA, Testing & UX Friction
*Focus: Verification and Human-Centric Quality.*
- **`testing-skill`**: Unit, integration, and E2E verification.
- **`testing-patterns`**: (Reference) Arrange-Act-Assert, mocking, and E2E patterns. Use `mcp_brainrouter_get_reference(name: "testing-patterns")`.
- **`adversarial-ux-skill`**: Persona-based friction testing framework.
- **`browser-testing-with-devtools`**: Real-time browser inspection, DOM analysis, and console debugging via MCP.

## 🔍 Scenario: Debugging & Troubleshooting
*Focus: Root-Cause Analysis.*
- **`debugging-and-error-recovery`**: Systematic Reproduce → Localize → Fix → Guard process.
- **`api-layered-debugging`**: Connectivity → Auth → Format → Semantics flow.

## 🐳 Scenario: Infrastructure & DevOps
*Focus: Containers, Automation, and Networking.*
- **`docker-lifecycle-engineering`**: Lifecycle, prune commands, and Dockerfile optimization.
- **`ci-cd-and-automation`**: Automated pipeline setup and quality gate automation.
- **`domain-infrastructure-routing`**: Cloudflare Tunnel → Traefik → Node.js pattern.
- **`git-workflow-and-versioning`**: Branching strategy, commit standards, and version control hygiene.

## 📝 Scenario: Proposals & Decision Making
*Focus: Trade-off Analysis and Architectural Records.*
- **`high-agency-communication`**: Standardized framework for technical proposals (1-3-1 Rule).
- **`documentation-and-adrs`**: Recording architectural decisions and documenting the "Why" behind the code.

## 📊 Scenario: Architecture Diagrams
*Focus: Visual Documentation.*
- **`concept-diagrams`**: Minimal SVG diagram system.

## 🔬 Scenario: Codebase Analysis & Exploration
*Focus: Understanding existing code, style, risks, and technical health.*
- **`conventions-skill`**: Naming patterns, formatting rules, import order, and module design standards.
- **`code-simplification`**: Reducing complexity while preserving behavior.
- **`code-review-and-quality`**: Multi-axis evaluation and quality gates.
- **`concerns-skill`**: Surfacing tech debt, known bugs, and security gaps.

## 🧠 Scenario: Agent Methodology & Planning
*Focus: Meta-cognition, requirement refining, and strict verification.*
- **`using-agent-skills`**: Meta-skill for skill discovery and operating behaviors.
- **`context-engineering`**: Systematic curation of agent context (Rules, Skills, Docs).
- **`interview-me`**: Proactive requirement gathering for underspecified tasks.
- **`doubt-driven-development`**: Adversarial self-review to disprove assumptions before implementation.
- **`source-driven-development`**: Mandatory verification against official framework documentation.
- **`idea-refine`**: Stress-testing raw concepts before committing to code.
- **`planning-and-task-breakdown`**: Systematic decomposition of complex features into tasks with active tracking via `task.md`.
- **`spec-driven-development`**: Creating technical specifications before writing a single line of logic.

## 🧠 Scenario: Agent Memory & Continuity
*Focus: Persistent awareness, cross-session recall, and user profiling.*
- **`agent-memory`**: Mandatory skill for managing the memory engine lifecycle (Recall/Capture/Cite).
- **`mcp_brainrouter_memory_search`**: (Tool) Use for deep retrieval when injected context is insufficient. Pass `asOf` (ISO 8601) to query what the memory engine knew at a specific point in time — useful for auditing past decisions.
- **`mcp_brainrouter_memory_mark_cited`**: (Tool) **Required after every response.** Signal which recalled memories you used (`citedRecordIds`) vs. all that were surfaced (`allRecalledRecordIds`). Drives citation-boosted recall ranking and auto-archives noise memories that are never cited.
- **`mcp_brainrouter_memory_contradictions`**: (Tool) Use to check for conflicting user instructions or past decisions.

## 🤖 Scenario: Specialized Expert Personas
*Focus: Adopting a specific role for deep analysis or fan-out orchestration.*
- **`code-reviewer`**: Staff Engineer persona for 5-axis PR reviews.
- **`security-auditor`**: Security Engineer persona for vulnerability detection and threat modeling.
- **`test-engineer`**: QA Engineer persona for coverage analysis and test strategy.
- **`orchestration-patterns`**: (Reference) Rules for persona composition and `/ship` fan-out patterns. Use `mcp_brainrouter_get_reference(name: "orchestration-patterns")`.

## 🚀 Scenario: Lifecycle & Delivery
*Focus: Preparation, Migration, and Incremental Shipping.*
- **`shipping-and-launch`**: Pre-flight checklists and production rollout strategies.
- **`project-handover-and-walkthrough`**: Summarizing accomplishments and providing a `walkthrough.md` for human review.
- **`deprecation-and-migration`**: Safely sunsetting legacy code and moving users to new implementations.
- **`incremental-implementation`**: Breaking large changes into manageable, reviewable PRs.

<!-- {{EXTRA_SCENARIOS}} — paste additional scenario blocks here -->

---

## 🎭 Orchestration: Skills, Personas, and Commands
{{PROJECT_NAME}} uses three composable layers to manage complexity:

- **Skills** (Global MCP): Workflows with steps and exit criteria. The **How**.
- **Personas** (Global MCP): Roles with a specific perspective (e.g., Security Auditor). The **Who**.
- **Commands**: User-facing entry points (e.g., `/review`). The **When**.

**Composition Rule:** Personas do not invoke other personas. A persona may invoke global skills using `mcp_brainrouter_get_skill`.

### 🔀 Persona Decision Matrix
- **Invoke `code-reviewer`**: When conducting 5-axis PR reviews (Correctness, Readability, Architecture, Security, Performance).
- **Invoke `security-auditor`**: When auditing sensitive flows (Auth, Data Protection, User Input), fixing known CVEs, or threat modeling new features.
- **Invoke `test-engineer`**: When defining test strategies, resolving QA gaps, or needing Prove-It tests for bug resolution.
- **Command `/ship`**: Triggers a parallel fan-out running all three experts simultaneously for maximum pre-production coverage.

---

**QUICK LOAD COMMAND:**
Look up the required resource name for your scenario, then use the appropriate tool to load the instructions:
- **Skills**: `mcp_brainrouter_get_skill(name: "<skill-name>")`
- **References**: `mcp_brainrouter_get_reference(name: "<reference-name>")`
- **Personas**: `mcp_brainrouter_get_persona(name: "<persona-name>")`
- **Docs (Templates)**: `mcp_brainrouter_list_template_docs()` or `mcp_brainrouter_get_template_doc(name: "<doc-name>")`
- **Memory Tools — RAG / Long-Term**:
  - `mcp_brainrouter_memory_recall` → inject context at turn start (returns `recalledL1Memories[].recordId`)
  - `mcp_brainrouter_memory_mark_cited` → signal citations after response (required — drives ACE loop)
  - `mcp_brainrouter_memory_capture_turn` → persist turn as final tool call (optional if passive hooks active)
  - `mcp_brainrouter_memory_search` → deep retrieval (supports `asOf` ISO param for point-in-time)
  - `mcp_brainrouter_memory_contradictions` → surface + resolve conflicting instructions
- **Memory Tools — Working Memory / Context Reduction**:
  - `mcp_brainrouter_memory_working_context` → fetch Mermaid task canvas & state block
  - `mcp_brainrouter_memory_working_offload` → offload large payloads (>1,000 tokens), return nodeId
  - `mcp_brainrouter_memory_working_reset` → flush working memory for session
- **Memory Tools — Software Engineering Workflow**:
  - `mcp_brainrouter_memory_task_state` / `mcp_brainrouter_memory_task_update` → structured progress tracking
  - `mcp_brainrouter_memory_failed_attempts` → query previously failed solutions
  - `mcp_brainrouter_memory_file_history` → query memories tied to specific file paths
  - `mcp_brainrouter_memory_debug_trace_save` / `mcp_brainrouter_memory_debug_trace_search` → record/query reproduction traces for bugs
  - `mcp_brainrouter_memory_handover` → produce handover summary with evidence links
  - `mcp_brainrouter_memory_verify` → verify memory and adjust confidence score

# [PROJECT_NAME] Agent Context Router

**AGENT INSTRUCTION:** This is your primary navigation hub. Do NOT scan the entire `/docs` directory. Instead, identify the user's task below and load ONLY the specifically linked skill files to minimize context noise.

---

## ⚖️ Core Rules

- **Skill-First Mindset**: If a task matches a skill, you MUST invoke it. Never implement directly if a skill applies.
- **Strict Adherence**: Follow skill instructions exactly. Do not partially apply them or "skip ahead" to code.
- **No Shortcuts**: Avoid "this is too small for a skill" or "I'll just quickly fix it" rationalization.

## 🔄 Execution Model

For every request:
1. **Detect Intent**: Map the user's request to a scenario below.
2. **Select Skill**: Identify the most relevant `SKILL.md`.
3. **Execute**: Follow the skill workflow strictly.
4. **Iterate**: Return to this router if the scenario changes (e.g., from Debugging to Shipping).

## 🗺️ Lifecycle Mapping
- **BOOTSTRAP** → [Bootstrap Skill](./skills/agent/bootstrap-skill/SKILL.md)
- **DEFINE** → [Spec-Driven Skill](./skills/agent/spec-driven-skill/SKILL.md)
- **PLAN** → [Planning Skill](./skills/agent/planning-skill/SKILL.md)
- **BUILD** → [Incremental Shipping](./skills/lifecycle/incremental-skill/SKILL.md) + [Testing Standards](./skills/api/testing-skill/SKILL.md)
- **REVIEW** → [Code Reviewer Agent](./agents/code-reviewer.md)
- **SHIP** → [Shipping & Launch Skill](./skills/lifecycle/shipping-skill/SKILL.md)

---

## 🏗️ Scenario: Backend & API Development
*Focus: Security, Auth, Performance, and Routes.*
- **[API Standards](./docs/api/API.md)**: Absolute source of truth for routes and architecture.
- **[Security Shield Skill](./skills/api/api-skill/SKILL.md)**: Mandatory middleware and validation boilerplate.
- **[Security Checklist](./references/security-checklist.md)**: OWASP Top 10 and common vulnerability prevention.
- **[Auth & Session Skill](./skills/api/auth-skill/SKILL.md)**: Identity, JWT rules, and "Kill Switch" logic.
- **[Performance Skill](./skills/api/performance-skill/SKILL.md)**: Redis caching and Postgres replication rules.
- **[Performance Checklist](./references/performance-checklist.md)**: SQL optimization and caching best practices.

## 🎨 Scenario: Frontend & UI Development
*Focus: Aesthetics, Components, and Motion.*
- **[Design Language](./docs/design/Design.md)**: Design tokens and component rules.
- **[Design Themes](./docs/design/themes/)**: Ready-to-use aesthetic systems (Apple, Pinterest, Vodafone, etc.).
- **[Premium Taste Skill](./skills/design/taste-skill/SKILL.md)**: High-end layout engineering and motion standards.
- **[A11y Skill](./skills/api/a11y-skill/SKILL.md)**: WCAG 2.1 AA accessibility mandates for frontend.
- **[Accessibility Checklist](./references/accessibility-checklist.md)**: Semantic HTML and screen reader compliance.

## 🧪 Scenario: QA, Testing & UX Friction
*Focus: Verification and Human-Centric Quality.*
- **[Testing Standards](./skills/api/testing-skill/SKILL.md)**: Framework-specific testing standards.
- **[Testing Patterns](./references/testing-patterns.md)**: Arrange-Act-Assert, mocking, and E2E patterns.
- **[Adversarial UX Skill](./skills/ux/adversarial-ux-skill/SKILL.md)**: Persona-based friction testing framework.
- **[Browser DevTools Skill](./skills/qa/browser-testing-skill/SKILL.md)**: Real-time browser inspection and debugging.

## 🔍 Scenario: Debugging & Troubleshooting
*Focus: Root-Cause Analysis.*
- **[Debugging & Error Recovery](./skills/agent/debugging-and-error-recovery/SKILL.md)**: Systematic Reproduce → Localize → Fix → Guard process.
- **[Layered Debug Skill](./skills/api/debug-skill/SKILL.md)**: Connectivity → Auth → Format → Semantics flow.

## 🐳 Scenario: Infrastructure & DevOps
*Focus: Containers, Automation, and Networking.*
- **[Docker Skill](./skills/devops/docker-skill/SKILL.md)**: Lifecycle, prune commands, and Dockerfile optimization.
- **[CI/CD Skill](./skills/devops/ci-cd-skill/SKILL.md)**: Automated pipeline setup and quality gate automation.
- **[Domain Skill](./skills/devops/domain-skill/SKILL.md)**: Networking and domain configuration patterns.
- **[Git Workflow Skill](./skills/codebase/git-workflow-skill/SKILL.md)**: Branching strategy and commit standards.

## 📝 Scenario: Proposals & Decision Making
*Focus: Trade-off Analysis and Architectural Records.*
- **[1-3-1 Decision Rule](./skills/communication/1-3-1-rule/SKILL.md)**: Standardized framework for technical proposals.
- **[ADR & Documentation Skill](./skills/agent/adr-skill/SKILL.md)**: Recording architectural decisions.

## 📖 Scenario: Documentation Maintenance
*Focus: Keeping docs in sync with reality.*
- **[Documentation Sync Skill](./skills/agent/sync-skill/SKILL.md)**: Aligning `API.md`, `Schema.md`, and `Design.md` with the latest code changes.
- **[Source-Driven Skill](./skills/agent/source-driven-skill/SKILL.md)**: Verifying code against official documentation.

## 📊 Scenario: Architecture Diagrams
*Focus: Visual Documentation.*
- **[Concept Diagrams](./skills/design/concept-diagrams/SKILL.md)**: Minimal SVG diagram system.

## 🔬 Scenario: Codebase Analysis & Exploration
*Focus: Understanding existing code, style, risks, and technical health.*
- **[Conventions Skill](./skills/codebase/conventions-skill/SKILL.md)**: Naming patterns and module design standards.
- **[Code Simplification Skill](./skills/codebase/code-simplification/SKILL.md)**: Reducing complexity while preserving behavior.
- **[Concerns Skill](./skills/codebase/concerns-skill/SKILL.md)**: Surfacing tech debt and security gaps.

## 🧠 Scenario: Agent Methodology & Planning
*Focus: Meta-cognition, requirement refining, and strict verification.*
- **[Using Agent Skills](./skills/agent/using-agent-skills/SKILL.md)**: Meta-skill for skill discovery.
- **[Interview Skill](./skills/agent/interview-skill/SKILL.md)**: Proactive requirement gathering.
- **[Doubt-Driven Skill](./skills/agent/doubt-driven-skill/SKILL.md)**: Adversarial self-review.
- **[Source-Driven Skill](./skills/agent/source-driven-skill/SKILL.md)**: Mandatory verification against official docs.
- **[Idea Refinement Skill](./skills/agent/idea-refine-skill/SKILL.md)**: Stress-testing raw concepts.
- **[Planning & Breakdown Skill](./skills/agent/planning-skill/SKILL.md)**: Feature decomposition.
- **[Spec-Driven Skill](./skills/agent/spec-driven-skill/SKILL.md)**: Technical specifications.

## 🤖 Scenario: Specialized Expert Personas
*Focus: Adopting a specific role for deep analysis.*
- **[Code Reviewer Agent](./agents/code-reviewer.md)**: Staff Engineer persona.
- **[Security Auditor Agent](./agents/security-auditor.md)**: Security Engineer persona.
- **[Test Engineer Agent](./agents/test-engineer.md)**: QA Engineer persona.
- **[Orchestration Patterns](./references/orchestration-patterns.md)**: Rules for persona composition.

## 🚀 Scenario: Lifecycle & Delivery
*Focus: Preparation, Migration, and Incremental Shipping.*
- **[Shipping & Launch Skill](./skills/lifecycle/shipping-skill/SKILL.md)**: Pre-flight checklists.
- **[Migration & Deprecation Skill](./skills/lifecycle/migration-skill/SKILL.md)**: Safely sunsetting legacy code.
- **[Incremental Shipping Skill](./skills/lifecycle/incremental-skill/SKILL.md)**: Breaking large changes into PRs.

---

## 🎭 Orchestration: Skills, Personas, and Commands
[PROJECT_NAME] uses three composable layers:

- **Skills** (`skills/<name>/SKILL.md`): Workflows with steps and exit criteria. The **How**.
- **Personas** (`agents/<role>.md`): Roles with a specific perspective. The **Who**.
- **Commands**: User-facing entry points. The **When**.

**Composition Rule:** Personas do not invoke other personas. A persona may invoke skills.

See [agents/README.md](./agents/README.md) for the full decision matrix.

---

## 🛠️ Creating a New Skill
Maintain the standard directory structure:

```
skills/
  {skill-name}/           # kebab-case
    SKILL.md              # Skill definition (Mandatory)
    scripts/              # Executable helpers (Optional)
      {name}.sh           # Bash scripts
```

### SKILL.md Template
```markdown
---
name: {skill-name}
description: {One sentence description + "Use when" triggers}
---
# {Skill Title}
## Workflow
{Numbered list of steps}
## Usage
{Example script calls or commands}
```

---

**QUICK LOAD COMMAND:**
`read_file(AGENT.md)` then load the `SKILL.md` for your specific scenario.

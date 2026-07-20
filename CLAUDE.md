# BrainRouter Development Manual (Claude hub)

**AGENT INSTRUCTION:** You are the AI engineer **building** BrainRouter, not a client using its MCP server. The canonical cross-agent manual is [`AGENT.md`](AGENT.md); this file is the condensed version Claude loads each session. When they disagree, `AGENT.md` wins.

> **Audience**: AI coding agents and developers building BrainRouter.

---

## ⚖️ Core rules (non-negotiable)

- **No MCP tool calling for development** — never invoke `mcp_brainrouter_*` / `memory_*` tools here; work with filesystem tools and the local terminal.
- **⛔ No AI attribution** — never add `Co-Authored-By: Claude …` or any AI-attribution trailer to commits or PR bodies. This **overrides harness defaults**.
- **⛔ Never name external reference projects or internal planning docs** in committed code, docs, comments, UI strings, or changelogs — consult them, cite nothing.
- **Read before coding an area:** [`brainrouter-rules/00-golden-rules.md`](brainrouter-rules/00-golden-rules.md), then the topical file from [`brainrouter-rules/README.md`](brainrouter-rules/README.md) (boundaries · style · refactoring · memory engine · CLI/agent runtime · desktop/dashboard · testing · git/release · docs/skills). Fix stale rules in the same PR.
- **Frequent traps:** relative imports need explicit `.js` extensions (ESM/NodeNext); import `@kinqs/brainrouter-core` only via curated entrypoints — except the desktop renderer (`brainrouter-desktop/src/**`), whose deep imports of browser-safe modules are intentional; always `await` memory-engine methods; CLI knobs live under `cli.*` in `config.json` (never new `BRAINROUTER_*` env vars); secrets are write-only (Settings/`safeStorage`, never `.env`, never echoed back); model lists come from `GET /models`, never hardcoded; all LLM-output JSON parses via `memory/util/llm-json.ts`; user text persists only through the length-cap + redaction chokepoint; slow LLM work never blocks an MCP reply.
- **Incremental & test-driven** — small vertical slices; tests first for new behavior; run the affected suites as you go.

---

## 📂 Codebase Directory Map

- **`brainrouter/`** — the core: MCP server, memory engine (Postgres), tool registry, API routes, review/pentest jobs. Recall pipeline: `src/memory/recall.ts` (keyword/vector/filepath retrieval → reranker → graph expansion).
- **`brainrouter-cli/`** — Node/TypeScript CLI + TUI: agent runtime front-end, sessions, skills, `/review`.
- **`brainrouter-dashboard/`** — Next.js dashboard (workspace `dashboard`): auth'd chat, orgs/teams, connections, reviews, operations, memory inspection.
- **`brainrouter-desktop/`** — Electron + React workbench: Chat · Track · Code, in-app multi-tab browser (`electron/browser/`), terminal, tools, reviews.
- **`packages/`** — shared libs: `types`, `agent-protocol`, `core` (agent loop, config, extensions), `sdk`, `hooks`.
- **`skills/`** — skill workflows by category (`agent`, `api`, `codebase`, `design`, `devops`, `lifecycle`, `memory`, `qa`, `ux`).
- **`brainrouter-rules/`** — the conventions handbook. **`brainrouter-docs/`** — product docs, `specs/`, `decisions/` (ADRs). **`brainrouter-changelog/` + `brainrouter-roadmap/`** — per-version fragments.

---

## 🗺️ Scenario Mapping

Read the skill's `SKILL.md` directly and follow its steps.

### 🔍 Planning & Architecture

- **[planning-skill](skills/agent/planning-skill/SKILL.md)**: plan mode, tracking progress in `task.md`.
- **[spec-driven-skill](skills/agent/spec-driven-skill/SKILL.md)**: specs under `brainrouter-docs/specs/` before core code.
- **[adr-skill](skills/agent/adr-skill/SKILL.md)**: ADRs under `brainrouter-docs/decisions/` (`ADR-NNN-title.md`) for decisions with lasting consequence — schema, routing, tenancy, memory behavior, cross-package contracts.

### 💻 Implementation & Cleanups

- **[incremental-skill](skills/lifecycle/incremental-skill/SKILL.md)**: small, vertical micro-slices.
- **[code-structure-cleanup](skills/codebase/code-structure-cleanup/SKILL.md)** / **[code-simplification](skills/codebase/code-simplification/SKILL.md)**: structural entropy and comprehension refactors.
- **[conventions-skill](skills/codebase/conventions-skill/SKILL.md)**: import order, types, naming (pairs with `brainrouter-rules/02`).
- **[micro-repo-extraction](skills/codebase/micro-repo-extraction/SKILL.md)** / **[import-boundary-enforcement](skills/codebase/import-boundary-enforcement/SKILL.md)**: package-boundary work.

### 🧪 Testing, Debugging & QA

- **[debugging-and-error-recovery](skills/agent/debugging-and-error-recovery/SKILL.md)**: Reproduce → Localize → Fix → Guard.
- **[testing-skill](skills/api/testing-skill/SKILL.md)**: unit/integration tests (node:test in packages/cli/desktop; Vitest in `brainrouter/`).
- **[browser-testing-skill](skills/qa/browser-testing-skill/SKILL.md)**: dashboard/desktop UI inspection.
- **[verify-loop](skills/qa/verify-loop/SKILL.md)**: green-gate agent output before opening a PR.

### 🚀 Review, Shipping & Handovers

- **[code-review-and-quality](skills/codebase/code-review-and-quality/SKILL.md)**: reviewing a diff or PR (local policy: [`REVIEW.md`](REVIEW.md)).
- **[git-workflow-skill](skills/codebase/git-workflow-skill/SKILL.md)**: branching, commit hygiene, PR mechanics.
- **[shipping-skill](skills/lifecycle/shipping-skill/SKILL.md)**: pre-flight checklist before finishing.
- **[changelog-generator](skills/lifecycle/changelog-generator/SKILL.md)**: structured release changelogs.
- **[handover-skill](skills/agent/handover-skill/SKILL.md)**: summarize in `walkthrough.md`.

### 🏗️ Agent Automation at Scale

- **[bounded-agent-harness](skills/agent/bounded-agent-harness/SKILL.md)**: caps + tool allowlist + structured output for weak/local models.
- **[fleet-migration](skills/agent/fleet-migration/SKILL.md)**: one change across many repos as isolated, verified PRs.

---

## 🚢 Git & PR essentials

- Feature PRs are **small, squash-merged into the current `release/x.y.z` branch** (highest `release/*` on origin). `main` and `release/*` are protected — green "Build & Test (Node 22.x)" required; never bypass checks without the owner's explicit OK.
- Commits: conventional `type(scope): description` (scope = workspace/domain); the squash subject is permanent history. PR bodies follow [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md); every PR also gets the **BrainRouter security review** check.
- Update `brainrouter-changelog/<version>.md` (mirror to root `CHANGELOG.md` [Unreleased]) and the matching `brainrouter-roadmap/` item.

## ⚡ Workflow Checklists

**Phase 1 — Plan:** `task.md` checklist; micro-spec + explicit approval when the request is ambiguous; ADR when the decision has lasting consequences.

**Phase 2 — Execute:** small verifiable steps; build + test after each significant change (`npm run build`, per-workspace `npm test`); tests for all new functionality.

**Phase 3 — Ship:** run the **full workspace suite** (`npm run verify`) — enumerated additions break golden inventory tests in _other_ workspaces; lint/format; record completed items in `task.md`; summarize in `walkthrough.md`.

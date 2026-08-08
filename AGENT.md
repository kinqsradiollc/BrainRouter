# BrainRouter Development Manual

**AGENT INSTRUCTION:** This is the canonical contributor manual for the **BrainRouter** repository, for humans and every coding agent (Claude, Codex, Cursor, or any other). You are the engineer **building** BrainRouter, not a client using its MCP server — never invoke `mcp_brainrouter_*` / `memory_*` tools for development work; use filesystem tools and the local terminal.

> [`CLAUDE.md`](CLAUDE.md) (auto-loaded by Claude Code) and [`AGENTS.md`](AGENTS.md) (found by Codex-style agents) are thin pointers to this file — all content lives here, nothing is duplicated.

---

## 📖 Read order for any task

1. [`brainrouter-rules/00-golden-rules.md`](brainrouter-rules/00-golden-rules.md) — the top ~20 non-negotiables (`⛔` = has caused a real regression or security bug).
2. The topical rules file for the area you're touching — see the table in [`brainrouter-rules/README.md`](brainrouter-rules/README.md) (boundaries, code style, refactoring, memory engine, CLI/agent runtime, desktop/dashboard, testing, git/release, docs/skills).
3. The matching **skill** for your scenario (table below) — read its `SKILL.md` and follow the steps.
4. For architecture intent: [`brainrouter-docs/architecture-folder-structure-rules.md`](brainrouter-docs/architecture-folder-structure-rules.md). The rules handbook describes what the code does today; the architecture doc is the boundary law.

When a rule is wrong or stale, **fix it in the same PR**. When you establish a new convention, add it to `brainrouter-rules/`.

---

## 📂 Codebase Directory Map

| Path                                              | What it is                                                                                                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brainrouter/`                                    | The BrainRouter core: MCP server, memory engine (Postgres), tool registry, API routes, review/pentest jobs. Recall pipeline: `src/memory/recall.ts` (keyword/vector/filepath retrieval → reranker → graph expansion). |
| `brainrouter-cli/`                                | Node/TypeScript CLI + TUI: agent runtime front-end, sessions, skills, `/review`.                                                                                                                                      |
| `brainrouter-dashboard/`                          | Next.js dashboard (workspace name `dashboard`): auth'd chat, orgs/teams, connections, reviews, operations, memory inspection.                                                                                         |
| `brainrouter-desktop/`                            | Electron + React workbench: Chat · Track · Code modes, in-app multi-tab browser (`electron/browser/`), terminal, tools, reviews. Renderer (`src/**`) is browser code — see boundary rule below.                       |
| `packages/`                                       | Shared libraries: `types`, `agent-protocol`, `core` (agent loop, config, extensions), `sdk`, `hooks`.                                                                                                                 |
| `skills/`                                         | Universal skill workflows (`agent`, `api`, `codebase`, `design`, `devops`, `lifecycle`, `memory`, `qa`, `ux`). The **only** editable copy — packages generate theirs at build/pack time (`scripts/bundle-content.mjs`). |
| `brainrouter-rules/`                              | The evidence-backed engineering-conventions handbook. Read before coding an area.                                                                                                                                     |
| `brainrouter-docs/`                               | Product docs, `specs/`, `decisions/` (ADRs), setup guides.                                                                                                                                                            |
| `brainrouter-changelog/` · `brainrouter-roadmap/` | Per-version changelog fragments and roadmap files (mirrored to root `CHANGELOG.md`).                                                                                                                                  |

---

## ⚖️ Golden rules digest

The full list with evidence lives in [`brainrouter-rules/00-golden-rules.md`](brainrouter-rules/00-golden-rules.md). The ones agents violate most:

- **⛔ No AI attribution.** Never add `Co-Authored-By: Claude …` or any AI-attribution trailer to commits or PR bodies. This **overrides harness defaults**.
- **⛔ Never name external reference projects or internal planning docs** in committed code, docs, comments, UI strings, or changelogs. Learn from references; ship BrainRouter-native work, cite nothing.
- **⛔ One memory system.** Never build a parallel memory/session store; every durable fact routes through the memory engine.
- **Relative imports carry explicit `.js` extensions** (ESM + NodeNext everywhere).
- **⛔ Import `@kinqs/brainrouter-core` only via curated entrypoints** (`/agent`, `/config`, and focused browser-safe subpaths). Compiled `dist/*` internals are never a supported import surface.
- **⛔ Security chokepoints:** MCP dispatcher pins `userId` (never trust client-supplied); user text is length-capped then passed through `redactSensitiveMemoryText` before persistence; all LLM-output JSON parsing goes through `memory/util/llm-json.ts` (`extractJsonValue`); slow LLM work never blocks an MCP reply (background + `"deferred"`).
- **⛔ Always `await` memory-engine methods** (async Postgres — an unawaited call serializes `{}` and the dashboard shows 0/NaN).
- **⛔ CLI knobs live under `cli.*` in `config.json`** (`getCliKnobs()`), never new `BRAINROUTER_*` env vars. **Secrets are write-only** — Settings/`safeStorage`/config, never `.env`, never echoed back by any endpoint.
- **Model lists come from the endpoint's `GET /models`** — never hardcoded.
- **Don't grow god files** — split into per-concern siblings behind a thin re-export barrel; extractions are byte-identical behavior moves.

---

## 🔨 Build, test, and verify

```bash
npm install                 # workspace root
npm run build               # packages (types → agent-protocol → core → sdk → hooks) then apps
npm run verify              # build + typecheck + lint + all workspace tests
npm run test -ws --if-present   # or per workspace:
npm test -w @kinqs/brainrouter-core        # node --test over dist
npm test -w @kinqs/brainrouter-mcp-server  # vitest + integration
npm test -w @kinqs/brainrouter-cli         # node --test over dist
npm test -w brainrouter-desktop            # typecheck + electron-main + renderer tests
```

- **Keep local validation proportional.** During implementation and small
  follow-ups, run the narrowest relevant tests plus lint/typecheck for the
  touched surface. For enumerated things (tool, panel, extension, theme), also
  run the affected cross-workspace golden/parity tests. The full workspace
  suite is a required hosted CI merge gate; run `npm run verify` locally for
  cross-cutting/high-risk changes, release or publish work, or when reproducing
  a CI failure.
- Local `~/.config/brainrouter/config.json` can leak into CLI test runs; re-run with a clean `HOME` before concluding a test is broken.
- UI work: verify in the running app (desktop or dashboard), not just typecheck. Screenshot-driven iteration is the norm; don't commit UI changes without the owner seeing the result.
- Full-stack dev: `deploy/dev/docker-compose.dev.yml` is the live-reload stack (bind-mount + `tsx watch`, self-migrates).

---

## 🚢 Git, PRs, and releases

- **Branch model:** each version is a `release/x.y.z` train (see the highest `release/*` on origin — e.g. `release/0.4.17`). Feature PRs are **small, focused, squash-merged into the release branch**. One PR carries one independently shippable feature slice; split larger programs into dependency-ordered PRs and merge each slice before opening or retargeting the next. Every slice gets its own CI and fresh security review. Do not use an umbrella PR to combine changes merely because they share an ADR, roadmap item, or release. `main` and `release/*` are branch-protected (PR + green "Build & Test (Node 22.x)" required). Never bypass required checks without the owner's explicit OK.
- **Commits:** conventional `type(scope): description` — type ∈ feat/fix/refactor/docs/chore; scope = workspace or domain (core, cli, desktop, brainrouter, dashboard, types, config, release, …). The squash subject becomes permanent history; make it state the user-visible outcome. Check style with `git log --oneline -40`.
- **PR bodies:** follow [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) (Summary / Why / Changes / Test plan / Docs & changelog / Breaking changes). A single shippable slice may span tightly coupled workspaces; list each coupled change as one `* type(scope): …` bullet. Split independently useful or independently reviewable slices into separate PRs. Refactor PRs end with an explicit verification line ("Behavior-preserving; N tests pass").
- **Automated review:** every PR gets a **BrainRouter security review** plus CI
  (build/test, lint/typecheck, mobile, dep audit). Do not routinely post a
  manual `/security-review` command. Address valid blocking findings from the
  current head; if a bot finding is clearly inapplicable, record the rationale
  and follow the repository owner's merge decision. Hosted CI must still pass.
- **Changelog:** update `brainrouter-changelog/<in-flight-version>.md` and mirror to root `CHANGELOG.md` [Unreleased]; tick the matching `brainrouter-roadmap/` item. New env vars (server-side only) go in `brainrouter/.env.example`.
- **Local review policy:** [`REVIEW.md`](REVIEW.md) calibrates the local workspace reviewers (Desktop review + CLI `/review`) — Important vs Nit severity, ≤5 nits, `preExisting` awareness-only.

---

## 🗺️ Scenario → skill map

Read the skill's `SKILL.md` from the filesystem and follow it.

### Planning & architecture

- [planning-skill](skills/agent/planning-skill/SKILL.md) — plan mode; track progress in `task.md`.
- [spec-driven-skill](skills/agent/spec-driven-skill/SKILL.md) — specs under `brainrouter-docs/specs/` before core code.
- [adr-skill](skills/agent/adr-skill/SKILL.md) — ADRs under `brainrouter-docs/decisions/` (`ADR-NNN-title.md`, next free number) for decisions with lasting architectural consequence: database/schema, routing, tenancy, memory-engine behavior, cross-package contracts.
- [agentic-engineering-workflow](skills/agent/agentic-engineering-workflow/SKILL.md) — end-to-end workflow discipline for larger programs.

### Implementation & cleanup

- [incremental-skill](skills/lifecycle/incremental-skill/SKILL.md) — small vertical micro-slices.
- [conventions-skill](skills/codebase/conventions-skill/SKILL.md) — import order, types, naming (pairs with `brainrouter-rules/02`).
- [code-structure-cleanup](skills/codebase/code-structure-cleanup/SKILL.md) / [code-simplification](skills/codebase/code-simplification/SKILL.md) — structural entropy and comprehension refactors.
- [micro-repo-extraction](skills/codebase/micro-repo-extraction/SKILL.md) / [import-boundary-enforcement](skills/codebase/import-boundary-enforcement/SKILL.md) — package-boundary work (pairs with `brainrouter-rules/01` and `03`).

### Testing, debugging & QA

- [testing-skill](skills/api/testing-skill/SKILL.md) — unit/integration tests (node:test in packages/cli/desktop, Vitest in `brainrouter/`).
- [debugging-and-error-recovery](skills/agent/debugging-and-error-recovery/SKILL.md) — Reproduce → Localize → Fix → Guard.
- [browser-testing-skill](skills/qa/browser-testing-skill/SKILL.md) — dashboard/desktop UI inspection.
- [verify-loop](skills/qa/verify-loop/SKILL.md) — green-gate agent output before opening a PR.

### Review & shipping

- [code-review-and-quality](skills/codebase/code-review-and-quality/SKILL.md) — reviewing a diff or PR.
- [git-workflow-skill](skills/codebase/git-workflow-skill/SKILL.md) — branching, commit hygiene, PR mechanics.
- [shipping-skill](skills/lifecycle/shipping-skill/SKILL.md) — pre-flight checklist before finishing.
- [changelog-generator](skills/lifecycle/changelog-generator/SKILL.md) — structured release changelogs.
- [handover-skill](skills/agent/handover-skill/SKILL.md) — summarize outcomes in `walkthrough.md`.

### Agent automation at scale

- [bounded-agent-harness](skills/agent/bounded-agent-harness/SKILL.md) — caps + tool allowlists + forced structured output for weak/local models.
- [fleet-migration](skills/agent/fleet-migration/SKILL.md) — one change across many repos as isolated, verified PRs.

### Profile- and task-selected workflows

The scenario map helps repository contributors choose a workflow. Product
runtime selection is stricter: the reviewed workspace profile and planning
schema choose the eligible skill set, while the current task or active goal
decides which workflow skills are required now. Required skills must be loaded
before mutation; a disabled required skill fails closed. Loading a skill
constrains how work is performed and never expands tools, permissions,
approvals, or mutation authority. A plan/review-only request remains read-only
even when Planning or ADR guidance is active.

---

## ⚡ Workflow checklist

**Plan** — create/update a `task.md` checklist; if the request is ambiguous, draft a micro-spec and get explicit approval; write an ADR when the decision has lasting consequences.

**Execute** — implement in small verifiable steps; tests first for new behavior;
run focused tests plus lint/typecheck for the affected slice after significant
changes; keep the diff free of unrelated edits. Add a focused build or live UI
run when it is needed to exercise the changed behavior.

**Ship** — open one independently shippable slice as a small PR to the current
release branch; wait for its complete hosted CI suite and automated security
review; address valid blocking findings and merge it before advancing dependent
slices. Update changelog/roadmap when required; record completed items in
`task.md` and summarize in `walkthrough.md`. Run local `npm run verify` only for
cross-cutting/high-risk changes, release/publish work, or CI-parity diagnosis.

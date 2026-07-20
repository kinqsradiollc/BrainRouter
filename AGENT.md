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
| `skills/`                                         | Universal skill workflows (`agent`, `api`, `codebase`, `design`, `devops`, `lifecycle`, `memory`, `qa`, `ux`).                                                                                                        |
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
- **⛔ Import `@kinqs/brainrouter-core` only via curated entrypoints** (`/agent`, `/config`, …). Sole exception: the desktop **renderer** (`brainrouter-desktop/src/**`) deep-imports browser-safe modules on purpose — never "fix" those or `vite build` breaks.
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
npm run verify              # typecheck + lint + all workspace tests
npm run test -ws --if-present   # or per workspace:
npm test -w @kinqs/brainrouter-core        # node --test over dist
npm test -w @kinqs/brainrouter-mcp-server  # vitest + integration
npm test -w @kinqs/brainrouter-cli         # node --test over dist
npm test -w brainrouter-desktop            # typecheck + electron-main + renderer tests
```

- **Run the full workspace suite before pushing**, not just the workspace you touched — adding an enumerated thing (tool, panel, extension, theme) breaks **golden inventory tests in other workspaces**.
- Local `~/.config/brainrouter/config.json` can leak into CLI test runs; re-run with a clean `HOME` before concluding a test is broken.
- UI work: verify in the running app (desktop or dashboard), not just typecheck. Screenshot-driven iteration is the norm; don't commit UI changes without the owner seeing the result.
- Full-stack dev: `deploy/dev/docker-compose.dev.yml` is the live-reload stack (bind-mount + `tsx watch`, self-migrates).

---

## 🚢 Git, PRs, and releases

- **Branch model:** each version is a `release/x.y.z` train (see the highest `release/*` on origin — e.g. `release/0.4.17`). Feature PRs are **small, focused, squash-merged into the release branch**. `main` and `release/*` are branch-protected (PR + green "Build & Test (Node 22.x)" required). Never bypass required checks without the owner's explicit OK.
- **Commits:** conventional `type(scope): description` — type ∈ feat/fix/refactor/docs/chore; scope = workspace or domain (core, cli, desktop, brainrouter, dashboard, types, config, release, …). The squash subject becomes permanent history; make it state the user-visible outcome. Check style with `git log --oneline -40`.
- **PR bodies:** follow [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) (Summary / Why / Changes / Test plan / Docs & changelog / Breaking changes). Multi-slice PRs keep one `* type(scope): …` bullet per slice. Refactor PRs end with an explicit verification line ("Behavior-preserving; N tests pass").
- **Automated review:** every PR gets a **BrainRouter security review** check plus CI (build/test, lint/typecheck, mobile, dep audit). Address blocking findings; a clean/neutral review passes.
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

---

## ⚡ Workflow checklist

**Plan** — create/update a `task.md` checklist; if the request is ambiguous, draft a micro-spec and get explicit approval; write an ADR when the decision has lasting consequences.

**Execute** — implement in small verifiable steps; tests first for new behavior; build + run the affected workspace's tests after each significant change; keep the diff free of unrelated edits.

**Ship** — run `npm run verify` (or the full per-workspace suites); update changelog/roadmap; open a small PR to the current release branch using the template; address the security-review bot; record completed items in `task.md` and summarize in `walkthrough.md`.

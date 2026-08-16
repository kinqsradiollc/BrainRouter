# BrainRouter Engineering Rules

**What this is:** a distilled, evidence-backed handbook of _how BrainRouter is
actually built_ — the naming, structure, invariants, and gotchas that a future
engineer or AI agent needs so they don't re-derive them (or violate them) on
every task. Every rule was extracted from real source files and carries a
`path:line` pointer so you can verify it against the code.

**Audience:** the future maintainer of this repo — human or agent. If you are an
AI agent picking up a task here, read [`00-golden-rules.md`](00-golden-rules.md)
first, then the topical file for the area you're touching.

**Relationship to other docs:**

- [`AGENT.md`](../AGENT.md) — the canonical _agent instruction hub_: which skill
  to read for which scenario, plus git/PR conventions. Start there for workflow;
  come here for conventions. (`CLAUDE.md` and `AGENTS.md` are thin pointers to
  it — nothing is duplicated.)
- [`brainrouter-docs/architecture-folder-structure-rules.md`](../brainrouter-docs/architecture-folder-structure-rules.md)
  — the _target architecture_ (the layer model: domain ← contracts ← ports ←
  services ← presentation, and the non-negotiables). That file is the boundary
  law. This folder does **not** restate it — it captures the concrete,
  learned-from-code conventions that sit on top of it. When they seem to
  disagree, the architecture doc wins on _intent_; this folder wins on _what the
  code does today_.

---

## How to use this folder

1. **Before writing code in an area, open its file below.** Each is short and
   scannable, organized as numbered rules with a one-line "why" and evidence.
2. **When a rule is wrong or stale, fix it here in the same PR.** These files
   are living. A rule that lies is worse than no rule. Update the `path:line`
   evidence when you move code.
3. **When you establish a new convention, add it here.** If a reviewer or a
   golden test forced you to do something a specific way, that's a rule — write
   it down so the next person doesn't relearn it the hard way.

## The files

| File                                                                               | Read it when you are…                                                       |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`00-golden-rules.md`](00-golden-rules.md)                                         | doing **anything** — the 30 non-negotiables                                 |
| [`01-monorepo-packages-and-boundaries.md`](01-monorepo-packages-and-boundaries.md) | touching package deps, imports, build order, or the browser/Node boundary   |
| [`02-code-style-and-conventions.md`](02-code-style-and-conventions.md)             | writing any `.ts`/`.tsx` — naming, quotes, imports, types, errors, comments |
| [`03-refactoring-and-god-files.md`](03-refactoring-and-god-files.md)               | splitting a large file or restructuring a folder                            |
| [`04-memory-engine-and-mcp-server.md`](04-memory-engine-and-mcp-server.md)         | working in `brainrouter/` (the MCP server, memory engine, recall, tools)    |
| [`05-cli-and-agent-runtime.md`](05-cli-and-agent-runtime.md)                       | working in `brainrouter-cli/` or the core agent loop / guardrails           |
| [`06-desktop-and-dashboard.md`](06-desktop-and-dashboard.md)                       | working in `brainrouter-desktop/` or `brainrouter-dashboard/`               |
| [`07-testing.md`](07-testing.md)                                                   | writing or running tests anywhere                                           |
| [`08-git-release-and-changelog.md`](08-git-release-and-changelog.md)               | committing, versioning, changelog, or publishing                            |
| [`09-docs-skills-and-plugins.md`](09-docs-skills-and-plugins.md)                   | authoring docs, specs, ADRs, skills, agent personas, or plugins             |

## Conventions used in these files

- **Rule** — the prescriptive instruction (do this / never that).
- **Why** — the consequence of getting it wrong, so you can judge when an
  exception is genuinely warranted.
- **Evidence** — `path:line` in the repo that demonstrates the convention.
- `⛔` marks a hard invariant that has caused a real regression or security bug
  when violated — treat these as non-negotiable.

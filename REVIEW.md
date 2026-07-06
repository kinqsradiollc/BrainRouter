# Review instructions

Review-only policy for BrainRouter, injected as the highest-priority block into
every code review (desktop auto-review, `/review`, and PR review). Keep it short —
general engineering conventions live in `brainrouter-rules/`, not here.

## What Important (🔴) means here

Reserve 🔴 Important for changes that would break behaviour or safety: incorrect
logic, a broken agent turn-loop / guardrail, a tenant-crossing memory read, a
secret written outside Settings, or a package-boundary violation that breaks a
build. Style, naming, and refactor suggestions are 🟡 Nit at most.

## Cap the nits

Report at most 5 🟡 Nits inline. If you found more, say "plus N more nits" in the
summary. If everything you found is a Nit, lead the summary with "No blocking issues".

## Always check

- **No AI-attribution in commits/PRs** — flag any `Co-Authored-By: Claude` or
  similar AI trailer added by this change.
- **Models come from the endpoint** — model pickers/defaults must be driven by the
  provider's `GET /models`, never a hardcoded model-name list or placeholder.
- **Secrets live in Settings → `config.json`**, never `.env`; CLI knobs live under
  `cli.*` in `config.json`, not new `BRAINROUTER_*` env vars.
- **LLM-output JSON** must be parsed through `packages/core/src/memory/util/llm-json.ts`
  (`extractJsonValue`), never a bare `JSON.parse` on model text.
- **Package boundaries** — no deep `dist/*` imports across packages; import a
  package's public barrel (e.g. `@kinqs/brainrouter-core/<subsystem>`).
- **Desktop renderer** must deep-import browser-safe core modules — a full-surface
  entrypoint that pulls `node:fs`/`node:crypto` breaks `vite build`.

## Verification bar

Every behaviour claim needs a `file:line` you actually read, not an inference from a
name. When an added enum value (role / provider / command / tool) could break a
golden-inventory count test in another workspace, say so explicitly.

## Do not report

- Anything the pre-commit hook or CI already enforces (lint, formatting, type errors).
- Files under `dist/`, `dist-electron/`, `.worktrees/`, or any `*.lock`.
- Pre-existing issues as blocking — mark them `preExisting` (🟣) for awareness only.

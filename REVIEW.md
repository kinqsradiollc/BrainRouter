# Local review instructions

This repository policy is loaded by the **local workspace review** paths:
Desktop review of uncommitted changes and CLI `/review`. It calibrates those
reviewers only.

It does **not** configure server-side GitHub pull-request jobs. The backend
security, code-review, and explicitly requested assessment lenses use their own
contracts and organization/repository policy. Dashboard and Desktop may queue or
inspect those jobs, but they do not own the lens logic.

## Important findings

Reserve Important (`critical` or `high`) for a change that would break behavior
or safety and should block merge: incorrect logic, data loss, a broken agent
turn/guardrail, tenant-crossing data access, credential exposure, or a package
boundary violation that breaks consumers.

Style, naming, and optional refactors are Nits (`low` or `info`) at most. Report
no more than five Nits inline. If every finding is a Nit, lead with “No blocking
issues.”

Set `preExisting: true` for a verified issue the change only touches but did not
introduce. Pre-existing findings are awareness-only and never block the gate.

## Always check

- **Repository instructions** — follow the applicable `AGENTS.md`, `AGENT.md`,
  `CLAUDE.md`, `.cursorrules`, or `codex.md` for every changed path.
- **No AI attribution** — flag an AI co-author trailer added by the change.
- **Model discovery** — model pickers and defaults must come from the configured
  provider endpoint, not a hardcoded model-name catalog.
- **Credential boundary** — local CLI credentials use the designated write-only
  configuration path; organization/provider/connector credentials use sealed
  server-side storage. Never move secrets into ordinary client state or return
  them from an API.
- **Tenant scope** — organization, project, workspace, owner, source, and
  integration filters must be authorized and enforced server-side.
- **Model JSON** — parse model-produced JSON through
  `packages/core/src/memory/util/llm-json.ts` (`extractJsonValue`) instead of a
  bare `JSON.parse`.
- **Package boundaries** — import a package's public root or exported subpath;
  never deep-import another package's generated `dist/*` files.
- **Desktop process boundary** — filesystem, credential, subprocess, and account
  access stays in the Electron host. Renderer imports must remain browser-safe.
- **Generated desktop artifacts** — when an Electron source change requires
  tracked output, verify that source and generated artifact stay synchronized.

## Verification bar

Every behavior claim needs a `file:line` that was actually read. Validate a
finding against callers, tests, and the relevant process boundary rather than
inferring behavior from a filename or identifier.

If an added enum value, role, provider, command, tool, route, or settings section
could break an inventory/golden test in another workspace, call out that risk
explicitly.

## Do not report

- Formatting, lint, or type errors that the existing pre-commit/CI gate will
  deterministically report.
- Generated output under `dist/`, `dist-electron/`, `.worktrees/`, or lockfiles.
- Unverified hypotheticals or a general desire for more tests.
- Pre-existing issues as blockers.

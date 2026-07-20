# {{PROJECT_NAME}} agent instructions

<!--
Copy this file to the project root as AGENT.md (and add a thin AGENTS.md pointing
at it so Codex-style agents find it), replace every placeholder, and remove this
comment.

Required placeholders:
  {{PROJECT_NAME}}       Human-readable project name
  {{PROJECT_PURPOSE}}    Two or three sentences describing the product
  {{STACK_DETAIL}}       Runtime, framework, data store, and package manager
  {{INSTALL_COMMAND}}    Dependency installation command
  {{DEV_COMMAND}}        Local development command
  {{BUILD_COMMAND}}      Production build command
  {{TEST_COMMAND}}       Primary test command
  {{TYPECHECK_COMMAND}}  Static type-check command, or "# Not applicable"
  {{LINT_COMMAND}}       Lint/format command, or "# Not applicable"
  {{DOCS_PATH}}          Documentation directory or index
  {{API_DOC_PATH}}       API contract or route documentation
  {{DESIGN_DOC_PATH}}    Design system or interface contract
  {{RULES_PATH}}         Engineering-conventions handbook, or "# Not applicable"
  {{SKILLS_PATH}}        Skill/workflow library directory, or "# Not applicable"
  {{ADR_PATH}}           Architecture-decision-record directory, or "# Not applicable"
  {{DEFAULT_BRANCH}}     Branch feature PRs target (e.g. main or release/x.y.z)
-->

> **Stack:** {{STACK_DETAIL}}
>
> **Audience:** engineers and coding agents working in this repository

## Project context

{{PROJECT_PURPOSE}}

Before making changes, read the nearest repository instructions that apply to
the files in scope. Check for `AGENTS.md`, `AGENT.md`, `CLAUDE.md`,
`.cursorrules`, and `codex.md` from the repository root down to the target
directory. A more specific instruction file takes precedence for files beneath
it.

Do not scan the whole repository when the task names a package, route, or file.
Start with the exact paths and use the documentation map below to expand only as
needed.

## Documentation map

| Need                                  | Source of truth                              |
| ------------------------------------- | -------------------------------------------- |
| Product and architecture              | [`{{DOCS_PATH}}`]({{DOCS_PATH}})             |
| Engineering conventions and gotchas   | [`{{RULES_PATH}}`]({{RULES_PATH}})           |
| Reusable task workflows (skills)      | [`{{SKILLS_PATH}}`]({{SKILLS_PATH}})         |
| Architecture decision records         | [`{{ADR_PATH}}`]({{ADR_PATH}})               |
| API routes, schemas, and status codes | [`{{API_DOC_PATH}}`]({{API_DOC_PATH}})       |
| Interface tokens and component rules  | [`{{DESIGN_DOC_PATH}}`]({{DESIGN_DOC_PATH}}) |
| Repository-specific review policy     | `REVIEW.md`, when present                    |

When a skill in [`{{SKILLS_PATH}}`]({{SKILLS_PATH}}) matches the task (planning,
spec writing, debugging, testing, review, shipping), read its `SKILL.md` and
follow its steps instead of improvising a workflow. When a conventions rule
turns out stale, fix it in the same PR.

## Build, test, and run

```bash
{{INSTALL_COMMAND}}
{{DEV_COMMAND}}
{{BUILD_COMMAND}}
{{TYPECHECK_COMMAND}}
{{TEST_COMMAND}}
{{LINT_COMMAND}}
```

Run the narrowest relevant test while iterating. Before reporting completion,
run the package or repository gate appropriate to the risk of the change — in a
multi-workspace repository, run the FULL suite: adding an enumerated thing
(tool, panel, route, theme) often breaks inventory tests in other workspaces.

## Working rules

- Read a file before editing it and preserve unrelated user changes in a dirty
  worktree.
- Make the smallest coherent change that satisfies the requested behavior.
- Validate external input, API responses, file paths, and trust-boundary data;
  do not add speculative checks to impossible internal states.
- Prefer existing public modules and patterns over new abstractions.
- Keep generated files and committed build artifacts in sync when the repository
  explicitly tracks them.
- Never commit, push, publish, deploy, or modify external systems unless the user
  authorizes that action.
- Never expose secrets in output, logs, diffs, screenshots, or test fixtures.
- Use clickable `file:line` evidence when explaining code behavior.

## Commits, PRs, and decisions

- Feature PRs are small and focused, target `{{DEFAULT_BRANCH}}`, and are
  squash-merged: the PR title becomes permanent history. Write conventional
  subjects — `type(scope): user-visible outcome` (type ∈
  feat/fix/refactor/docs/chore; scope = the workspace or domain).
- Follow the pull-request template when one exists (summary, why, changes, test
  plan, docs/changelog, breaking changes). Behavior-preserving refactor PRs end
  with an explicit verification line (what passed, how many tests).
- Do not add AI-attribution trailers (for example `Co-Authored-By: <model>`)
  to commits or PR bodies when repository policy forbids them — check the
  conventions handbook before your first commit.
- Record decisions with lasting architectural consequence (schema, routing,
  tenancy, cross-package contracts) as an ADR under
  [`{{ADR_PATH}}`]({{ADR_PATH}}) before or alongside the implementing PR.
- Update the changelog/roadmap entries the repository maintains for the
  in-flight version as part of the same PR.

## Change workflow

1. Restate the observable outcome and acceptance criteria.
2. Inspect the current implementation, tests, and applicable instructions.
3. Add or update a failing test when behavior changes.
4. Implement one coherent vertical slice.
5. Run targeted tests, then the broader required gate.
6. Inspect the final diff for unrelated edits, secret material, and generated
   artifact drift.
7. Report the outcome, validation commands, and any remaining limitation.

For a diagnosis-only request, stop after identifying and evidencing the cause.
Do not silently turn diagnosis into implementation.

## Architecture boundaries

Document this project's non-negotiable boundaries here before using the
template. At minimum, identify:

- which package owns business logic;
- which clients may call it and through which public API;
- which process owns filesystem, network, or credential access;
- how tenant, project, workspace, or account scope is enforced;
- which data is durable and which state is only a client cache.

Project-specific boundaries:

- {{PROJECT_ARCHITECTURE_BOUNDARY_1}}
- {{PROJECT_ARCHITECTURE_BOUNDARY_2}}
- {{PROJECT_ARCHITECTURE_BOUNDARY_3}}

## Security and data handling

- Treat credentials as write-only. Store them only through the project's
  designated secret path and never return a stored secret to a client.
- Authorize on the server for every organization, project, repository, or user
  scope; a hidden client control is not authorization.
- Authenticate inbound webhooks with the provider's signature contract and keep
  signing secrets separate from account API credentials.
- Apply least privilege to tools, subprocesses, network access, and repository
  writes.
- Redact secrets and personal data before persistence, telemetry, or model input
  whenever the product contract requires it.

## UI work

- Follow [`{{DESIGN_DOC_PATH}}`]({{DESIGN_DOC_PATH}}) for tokens, layout,
  navigation, copy, motion, responsive behavior, and accessibility.
- Preserve keyboard operation, visible focus, reduced-motion behavior, and
  readable contrast.
- Implement loading, empty, error, disabled, and success states for changed
  interactions.
- Verify the actual application in a browser or native shell; a typecheck alone
  does not prove layout or interaction behavior.

## API and persistence work

- Treat [`{{API_DOC_PATH}}`]({{API_DOC_PATH}}) as the route contract.
- Keep request validation, authentication, authorization, and data filtering on
  the server boundary.
- Make migrations forward-safe and test both new and existing data paths.
- Do not expose internal exception text or provider credentials in API errors.
- Update shared types and client SDK contracts when a public response changes.

## Review policy

When `REVIEW.md` exists, it controls local repository review severity, skip
rules, nit limits, and project-specific checks. It does not grant write access or
weaken sandbox, network, secret, or approval policy.

Keep local workspace review separate from any server-side pull-request review
service. The local file only applies where the review runner explicitly loads
it.

## BrainRouter-aware hosts

When the host exposes BrainRouter tools, use them as a scoped continuity layer;
do not invent calls when the tools are unavailable.

1. Resolve or reuse the task session with `memory_resolve_session`.
2. Recall only context relevant to the active project or workspace with
   `memory_recall`; use `memory_search` for a focused follow-up.
3. Load a named workflow with `get_skill` when it clearly matches the task.
4. Offload large logs or file excerpts with `memory_working_offload` when that
   improves context quality.
5. Mark only records actually used with `memory_mark_cited`.
6. Capture the final outcome with `memory_capture_turn` when passive capture is
   not active.

Memory is supporting evidence, not a substitute for reading current code. Verify
drift-prone facts against the live repository before changing behavior.

## Handoff

A completion report must include:

- the user-visible outcome;
- important files changed;
- exact validation commands and results;
- known limitations or follow-up work;
- confirmation that no commit or external mutation was made, unless one was
  explicitly requested and completed.

---
name: import-boundary-enforcement
description: Make the architecture's layering machine-enforced so it can't silently erode. Use when a monorepo has a layered/acyclic package graph but nothing prevents back-edges or deep-internal imports, when many agents or contributors edit concurrently, or right after giving a package a curated public API. Use to add a lint rule that bans deep dist/internal imports and forbidden cross-package edges.
hints: |
  - Encode the real layer DAG (leaves → core → adapters → apps) as the allowed edges; everything else is denied.
  - Ban deep compiled-internal imports (e.g. `@pkg/dist/*`) and app→app + lower→higher back-edges explicitly.
  - Introduce rules in `warn` first (or changed-files-only) to avoid a flag day on a large existing tree, then ratchet to `error`.
  - The rule is worthless unless CI fails on violation AND a pre-commit hook catches it early — wire both.
  - Pair with `micro-repo-extraction`: the boundary lint lands together with the curated exports map, not before.
---

# Import-Boundary Enforcement

## Overview

A clean layered architecture decays the moment it is only a convention. With many agents and contributors editing in parallel, a single `core → app` back-edge or a deep `dist/*` import slips in and nothing fails until a human notices weeks later. This skill turns the layering into a **lint rule that fails CI**, so the boundary defends itself.

## When to Use

- The package graph is layered and acyclic *by intention* but unenforced
- You just gave a package a curated public API and want to stop callers reaching past it
- Concurrent agents/contributors keep eroding the architecture
- You need build order + boundaries to hold at fleet/automation scale

**When NOT to use:** a tiny single-package project with no layering to protect; or before the public API exists (you'd be banning the only imports that work).

## Workflow

1. **Write down the allowed edge set.** From the dependency audit, list every legitimate package→package edge (the DAG). Everything not listed is denied.
2. **Choose the tool.** `eslint-plugin-import` (`no-restricted-paths`) + `eslint-plugin-boundaries`, or `dependency-cruiser` for a standalone graph rule. Prefer whatever already runs in CI.
3. **Encode three bans:** (a) deep compiled-internal imports (`@pkg/dist/*` and any private subpath), (b) back-edges (lower layer importing a higher one; an app importing another app), (c) cycles.
4. **Roll out in `warn` first** (or scoped to changed files) to avoid a remediation wave on a large tree; fix violations; then promote to `error`.
5. **Gate it:** make the lint a required CI check **and** add it to the pre-commit hook so violations are caught before push.

## Patterns

- **Allowlist, not denylist:** enumerate permitted edges; deny the rest. New packages must be explicitly allowed — friction in the right place.
- **Warn-then-error ratchet:** never drop a hard rule on thousands of files at once; warn, clean, ratchet.
- **Two gates:** pre-commit for fast feedback, CI for the hard wall. One without the other leaks.
- **Co-land with the API:** the ban on deep imports is only safe once the curated entrypoints exist for callers to use instead.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "Everyone knows the layering, we don't need a rule." | Conventions aren't enforced; the next concurrent edit breaks them silently. |
| "We'll turn it on as `error` right away." | A flag day red-lights every open PR. Warn first, then ratchet. |
| "The lint is enough; CI doesn't need it." | A local-only rule is advisory. If CI is green on a violation, the boundary is fiction. |
| "Deep imports are fine, they work." | They couple callers to compiled layout and freeze the internals — the exact rot you're fixing. |

## Red Flags

- The rule exists but isn't a required status check.
- It was added as `error` and now every PR is red — you skipped the ratchet.
- The allowed-edge list drifts from the real graph (new package added, rule not updated).
- Pre-commit passes but CI has no boundary check (or vice-versa).

## Verification

- Add a deliberately-bad import (a back-edge and a deep `dist/*`) on a scratch branch → lint **and** CI fail with a clear message.
- Remove it → green.
- A new legitimate package without an allowlist entry fails until added — confirms it's an allowlist.
- Pre-commit blocks the bad import locally before it can be pushed.

---
name: micro-repo-extraction
description: Safely carve a subsystem out of a god-package into its own package with a real public API, leaf-first. Use when a package has grown too large, when consumers import its compiled internals (deep dist/* paths) instead of a public entrypoint, or when you need to split a monorepo unit without breaking its dependents. Use before any internal refactor that is blocked by callers reaching into private files.
hints: |
  - Give the package a curated `exports` map BEFORE moving any files — that captures ~80% of the benefit at ~10% of the risk.
  - Ban deep `dist/*`/internal-path imports with a lint rule; migrate callers to the public entrypoints one subsystem per PR.
  - Extract leaf-first (depend on nothing → depended on by nothing-yet): foundation, then platform, then the coupling sinks.
  - Never move a file and rewrite its callers in the same PR — split into "add entrypoint" then "migrate callers" then "remove wildcard".
  - Verify each step builds + typechecks + tests green for every touched workspace before the next move.
---

# Micro-Repo / Package Extraction

## Overview

Large packages rot not because they have many files but because their **boundary leaks**: consumers import compiled internals (`@pkg/dist/<subsystem>/<file>.js`) instead of a curated public API, which couples everyone to the file layout and freezes the internals. This skill restores the boundary first, then (optionally) splits the package — in small, independently-verifiable steps that never break the build.

## When to Use

- A package exports an empty/near-empty barrel and consumers reach inside via deep paths
- One subsystem fans into most of the others (a "god-module") and you need to break the coupling
- You want to split a monorepo unit but a single big-bang PR would be unreviewable and unmergeable
- A refactor is blocked because callers depend on private structure

**When NOT to use:** the package already exposes a clean public API and callers respect it; or the unit genuinely belongs in a separate repo with its own release lifecycle (then it's a repo split, not this).

## Workflow

1. **Map the dependency graph first.** Count, per subsystem, how many siblings it imports and how many import it. Identify leaves (import only foundation), sinks (imported by everyone), and the god-module (imports most siblings). Confirm the graph is acyclic.
2. **Design the public API before moving files.** Replace the empty barrel + any `"./dist/*"` wildcard export with a curated `exports` map: one subpath entrypoint per subsystem, each backed by a small `index.ts` barrel that re-exports only the intended surface.
3. **Migrate callers, one subsystem per PR.** Codemod the deep imports for a single subsystem to its new entrypoint. Keep each PR bounded and reviewable. Run the full verify for every touched workspace.
4. **Remove the wildcard export + turn on the boundary lint** only after every subsystem is migrated (pairs with `import-boundary-enforcement`).
5. **Only then, optionally move files into sub-packages** — leaf-first. For each: extract → standalone build → consumers import only its barrel → verify green. Break the god-module's fan-in with internal interfaces, not more cross-imports.

## Patterns

- **API-before-files:** the curated exports map alone unblocks future refactors without moving a single file — do it first, ship it, measure.
- **One-subsystem-per-PR codemod:** bound the blast radius; a failed migration reverts one subsystem, not the world.
- **Leaf-first extraction:** foundation (config/storage/util) → platform → runtime/sinks. Never extract a sink before its leaves have a stable API.
- **Interface-to-break-fan-in:** when the god-module must keep talking to N siblings, invert with a narrow interface it owns, so the dependency points inward.

## Common Rationalizations

| Excuse | Reality |
|---|---|
| "Just move the files, callers are easy to fix." | Moving + rewriting callers together makes the PR unreviewable and the build red mid-way. Split the steps. |
| "We'll add the exports map later." | The wildcard export is the leak. Without the curated API, every new caller deepens the coupling. API first. |
| "Polyrepo would isolate it properly." | Separate repos add version negotiation + cross-repo PRs. Only justified when the unit has an independent release lifecycle. |
| "One big PR is faster." | It's faster to write and impossible to review, bisect, or revert. Bounded PRs are faster end-to-end. |

## Red Flags

- You're editing `package.json` `exports` **and** moving files **and** rewriting callers in one commit.
- The build is red between steps and you're "going to fix it at the end."
- A new entrypoint re-exports the whole subsystem (no curation) — that's the wildcard with extra steps.
- You extracted a sink before its leaves had stable public APIs.

## Verification

- After the exports map: every entrypoint resolves (`tsc` + a runtime `import()` smoke test); no consumer change yet.
- After each caller-migration PR: `verify` (typecheck + lint + test) green for every touched workspace; grep shows zero deep imports for that subsystem.
- After wildcard removal: the boundary lint fails on a deliberately-added deep import.
- After a file move: the extracted package builds standalone and its dependents build against its barrel only.

# 08 — Git, Release & Changelog

Commit conventions, branch model, lockstep versioning, the two-tier changelog, and
the manual publish flow.

---

## Commits & PRs

### 1. Commit subjects: conventional `type(scope)` + squash PR suffix

Write subjects as `type(scope): description` — type ∈
feat/fix/refactor/docs/chore, scope = the workspace or domain (core, cli, desktop,
brainrouter, types, apps, agent, track, connectors, dashboard, plugin, config,
release). PRs are **squash-merged**, so your subject becomes `… (#NNN)` on the
target branch. Subjects are long, descriptive fragments stating the user-visible
outcome, often with em-dash detail
(`feat(plugin): plugin + marketplace system (P1–P5) — manifest, loader, registry, desktop UI, publish (#797)`).
Verify style with `git log --oneline -80`.

- **Why:** the changelog is assembled from these subjects; scopes map 1:1 to
  workspaces so history is greppable per package.
- **Evidence:** `.github/PULL_REQUEST_TEMPLATE.md`, recent `git log`

### 2. ⛔ No AI co-author trailers in commits or PR bodies

**This overrides the harness default.** Never add `Co-Authored-By: Claude …` or any
AI-attribution trailer to commits or PR bodies. Squash-merge bodies instead carry
per-slice commit subjects as `*` bullets plus a verification line.

- **Why:** the maintainer scrubbed all Claude co-author trailers from full history
  on 2026-06-02 and force-pushed. A handful of stray trailers from external cloud
  sessions exist in history — treat them as mistakes, not precedent.
- **Evidence:** `.github/PULL_REQUEST_TEMPLATE.md`

### 3. PRs contain one independently shippable feature slice

Use the template sections (Summary / Why / Changes / Test plan checkboxes / Docs &
changelog checkboxes / Breaking changes defaulting to "none"). New env vars must be
documented in `brainrouter/.env.example` or `brainrouter-cli/.env.example`.
Behavior-preserving refactor PRs end the body with an explicit verification line
(e.g. "Behavior-preserving split; public surface unchanged. Verified: 732 cli tests
pass.").

One PR carries one independently shippable feature slice. Split a larger program
into dependency-ordered PRs, merge each slice into the release branch, then base or
retarget the next slice on that updated branch. Each slice must receive its own CI
run and fresh security review. Do not create an umbrella PR merely because changes
share an ADR, roadmap item, or release target. A single slice may span tightly
coupled workspaces when separating them would leave the product broken; list each
coupled change as one `* type(scope): …` bullet so the squash body remains readable.

- **Why:** small independently valid diffs are easier to adjust, revert, and audit;
  a fresh security result then describes exactly the feature being shipped. The
  squash body remains the permanent history entry, and the verification line helps
  reviewers distinguish mechanical refactors from behavior changes.
- **Evidence:** `.github/PULL_REQUEST_TEMPLATE.md`

---

## Branches & versioning

### 4. Release trains on `release/x.y.z`; tag `vX.Y.Z` on the merge to main

Each version is developed on a `release/x.y.z` branch (current:
`release/0.4.18`). Feature PRs target the release branch and are squash-merged. To
ship: merge `origin/main` into the release branch, land the bump + changelog
commits, open a PR from the release branch into `main`, and tag the merge commit
`vX.Y.Z`. Release-bump work can go through a `chore/release-x.y.z` side branch.
The same release tag also starts the desktop packaging pipeline; the legacy
`desktop-v*` tag namespace remains accepted for desktop-only rebuilds.

- **Why:** `main` and `release/*` are branch-protected (PR + green "Build & Test
  (Node 22.x)" required); the `vX.Y.Z` tag on the main-merge commit marks a
  published version.
- **Evidence:** `.githooks/README.md:17`, `.github/workflows/release-desktop.yml:16`

### 5. ⛔ Lockstep versioning across all workspaces

Every publishable package (`@kinqs/brainrouter-types`, `-agent-protocol`, `-core`,
`-sdk`, `-hooks`, `-mcp-server`, `-cli`) and every private app (dashboard, desktop,
monorepo root) carries the **same** version, and inter-package deps pin
`^<that version>` (not `workspace:`). Only private `brainrouter-benchmark` differs.
**Never bump one package independently.**

- **Why:** publishing in dependency order relies on each package's deps referencing
  the real semver of what published before it, so a fresh install resolves cleanly.
- **Evidence:** `package.json:4`, `brainrouter-cli/package.json:3`

### 6. Release close = two stereotyped commits touching every manifest

Ending a cycle needs (1) `chore(release): bump all packages + manifests to X.Y.Z`
— updates version AND inter-package `^X.Y.Z` pins in every workspace
`package.json`, the root `package.json`, `package-lock.json`,
`brainrouter/server.json` (version appears **twice**), and
`.claude-plugin/plugin.json`; and (2) `docs(release): X.Y.Z changelog + roadmap
status`. Missing `server.json` or `plugin.json` is a known slip — double-check them.

- **Evidence:** `package.json:4`, `brainrouter/server.json:5`, `.claude-plugin/plugin.json:4`

### 7. `VERSION` reads from `package.json` at runtime — never hardcode

Each runtime package has a `version.ts` reading its own `package.json` at load and
exporting `VERSION`; every surface (CLI banner, MCP serverInfo/clientInfo,
User-Agent) imports that constant. A golden test asserts `VERSION ===
package.json` version. (SETUP.md §5.2's "5 hardcoded source-code references" list is
**stale** — version centralization made the bump `package.json`-only; the actual
0.4.16 bump touched 13 manifest files and zero `.ts` files.)

- **Evidence:** `packages/core/src/version.ts`, `packages/core/src/tests/version.test.ts`

---

## Changelog & roadmap

### 8. Changelog source of truth is `brainrouter-changelog/<version>.md`

User-visible changes go in the in-flight version file under `brainrouter-changelog/`
(start from `CHANGELOG_TEMPLATE.md`: intro paragraph, then Breaking/Removed, Added,
Changed, Fixed, Tests/Verification, Notes; 40–100 lines, user-facing language
first). Root `CHANGELOG.md` stays a concise "Current Release View" table + short
summaries — never a duplicate of the full file. When a version ships, replace
`Unreleased` with the date in both places and add a row to
`brainrouter-changelog/README.md`'s index table.

- **Why:** the two-tier changelog keeps the root file scannable while per-version
  files ship inside the CLI package for `/release-notes`.
- **Evidence:** `brainrouter-changelog/README.md:44-55`, `brainrouter-changelog/CHANGELOG_TEMPLATE.md`

### 9. `brainrouter-cli/changelog/` is generated at publish — never edit or commit it

It's gitignored and synthesized by the CLI's `prepublishOnly` → `sync-changelog`
script, which wipes it and copies every `.md` from repo-root
`brainrouter-changelog/`. `/release-notes` reads this bundled copy. **Edit only
`brainrouter-changelog/`.**

- **Evidence:** `.gitignore:32-35`, `brainrouter-cli/package.json:27-28`

### 10. Roadmap and changelog are strictly separated

Planned/future work goes in root `ROADMAP.md` (executive view) and
`brainrouter-roadmap/<version>.md` (per-release plans) — **never** in changelog
files. When a PR completes or re-scopes a planned item, update the matching roadmap
file. Explicitly rejected ideas live in
`brainrouter-roadmap/intentionally-excluded.md`.

- **Why:** changelogs record only what shipped; mixing plans in breaks the
  `/release-notes` bundle and the Keep-a-Changelog contract.
- **Evidence:** `brainrouter-changelog/README.md:52-53`, `brainrouter-roadmap/README.md`

---

## Publish & tooling

### 11. npm publish is manual, in dependency order, with absolute paths

Publish order is fixed: `packages/types` → `packages/agent-protocol` →
`packages/core` → `packages/sdk` → `packages/hooks` → `brainrouter` →
`brainrouter-cli`, using **absolute** `cd` paths (on macOS's case-insensitive FS,
relative `cd ../brainrouter` can land on the private monorepo root `BrainRouter/`
and fail with `EPRIVATE`) and no inline `#` comments (zsh treats them as args).
Auth is a granular `@kinqs/*` npm token with Bypass-2FA in `~/.npmrc`. Before
publishing: `npm run verify` green, then `npm pack --dry-run` per package to check
name/version, no `*.test.*` files, no `.env`/credentials, sane sizes.

- **Why:** each package's deps pin the real semver of the ones published before it,
  so out-of-order publishes leave the registry unresolvable.
- **Evidence:** `SETUP.md:440-450,398-400`

### 12. Pack hooks bundle monorepo content and must leave the tree clean

The MCP server's `prepack` copies repo-root `skills/`, `agents/`, `references/`,
`docs/` into the package (recording them in `.bundled-content.json`) and `postpack`
removes exactly what was copied (skipping dirs that already existed). The CLI's
`prepack` builds then strips `*.test.*` from `dist/`; its `files` array whitelists
`changelog`. To change what ships, edit these scripts and the `files` arrays —
**never commit copies of root content into a package.**

- **Evidence:** `brainrouter/scripts/prepack.mjs`, `brainrouter/scripts/postpack.mjs`

### 13. `install-git-hooks.mjs` must stay fully defensive

Run from `prepare` on every `npm install`, it must never fail: it no-ops outside
this repo's own work tree, no-ops if the user set a custom `core.hooksPath`, and
swallows every error (exit 0). Preserve these guards — a thrown error there breaks
every install (including `npm ci` in CI and tarball installs).

- **Evidence:** `scripts/install-git-hooks.mjs:20-42`

### 14. Root `.pkg.json` and `.ci.yml` are gitignored stale scratch copies

`.pkg.json` (a 0.4.14-era copy of `brainrouter/package.json`) and `.ci.yml` (a
pre-Postgres copy of the CI workflow) are gitignored and have no git history. The
real files are `brainrouter/package.json` and `.github/workflows/ci.yml`. **Never
edit the root copies expecting effect, and never commit them.**

- **Evidence:** `.gitignore:121-122`

### 15. Desktop packages share the release tag and keep a manual rebuild path

Signed/notarized macOS builds run via `.github/workflows/release-desktop.yml`,
triggered by a normal `vX.Y.Z` release tag, manually, or by the legacy
`desktop-v*` desktop-only tag.
`electron-builder` + `@electron/notarize` install with `npm install --no-save` so
the committed lockfile stays the deterministic source of truth; without Apple
secrets the pipeline fails open to an unsigned build so it stays verifiable.

- **Evidence:** `.github/workflows/release-desktop.yml:16-17,42-45`

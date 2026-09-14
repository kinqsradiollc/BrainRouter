# Git hooks (Refactor R0.3)

Committed hooks, wired via `core.hooksPath=.githooks`. They install automatically
on `npm install` (the root `prepare` script → `scripts/install-git-hooks.mjs`,
which is fully defensive and never breaks `npm ci`).

## `pre-commit`

Lints **only the staged** `.ts/.tsx/.js/.mjs/.cjs` files with the repo's ESLint
(catches boundary-rule + lint errors before CI), and rejects a raw NUL byte
(0x00) in any staged text file (`scripts/check-no-raw-nul.mjs` — a sentinel is
written as the `\0` escape, never as the invisible byte; the same gate runs
repo-wide in CI as `npm run lint:nul`). No `prettier --write` (would churn the
not-yet-formatted tree) and no full build/test (too slow for a hook).

**Bypass** when you need to: `git commit --no-verify` or `BR_SKIP_HOOKS=1 git commit …`.

Manual (re)install: `npm run hooks:install`.

## Branch protection (repo-admin — cannot be set from code)

Pair this local gate with a server-side gate on GitHub so the green bar is
enforced for everyone:

> Settings → Branches → Add rule for `main` (and `release/*`):
> **Require a pull request before merging** + **Require status checks to pass**
> → select **Build & Test (Node 22.x)**.

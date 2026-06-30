# Git hooks (Refactor R0.3)

Committed hooks, wired via `core.hooksPath=.githooks`. They install automatically
on `npm install` (the root `prepare` script → `scripts/install-git-hooks.mjs`,
which is fully defensive and never breaks `npm ci`).

## `pre-commit`

Lints **only the staged** `.ts/.tsx/.js/.mjs/.cjs` files with the repo's ESLint
(catches boundary-rule + lint errors before CI). No `prettier --write` (would
churn the not-yet-formatted tree) and no full build/test (too slow for a hook).

**Bypass** when you need to: `git commit --no-verify` or `BR_SKIP_HOOKS=1 git commit …`.

Manual (re)install: `npm run hooks:install`.

## Branch protection (repo-admin — cannot be set from code)

Pair this local gate with a server-side gate on GitHub so the green bar is
enforced for everyone:

> Settings → Branches → Add rule for `main` (and `release/*`):
> **Require a pull request before merging** + **Require status checks to pass**
> → select **Build & Test (Node 22.x)**.

# Runbook — Activating advanced CodeQL for the ADR-039 taint engine

**Status:** owner-activated. Everything the review pipeline needs in code is
shipped and live against the repo's **default-setup** CodeQL scan (SARIF →
source→sink paths → review candidates, with a `CODEQL_NOT_ANALYZED` coverage
limitation when a scan is absent). This runbook covers the two improvements that
require a one-time repository-settings change only a repo admin can make:

1. **`security-extended` query suite** — broader precision-tuned security queries
   than the `default` suite the repo currently runs (ADR-039 D3: "select by
   precision, do not invent our own filter").
2. **The D4 barrier model** — teaching the engine OUR chokepoints
   (`brainrouter/src/reviews/impact/adr039BarrierPack.ts`) so it proves a barrier
   dominates a tainted path and does **not** emit the finding we already fixed
   (ADR-039 D4; §6 "fixed code stays fixed").

> **Why this is not committed as a live workflow.** The repo runs CodeQL
> **default setup** (`code-scanning/default-setup` = `configured`). GitHub does
> not allow a default-setup scan and an advanced `.github/workflows/codeql.yml`
> to coexist — committing the workflow while default setup is on breaks scanning.
> So the workflow and config below are templates you drop in **after** disabling
> default setup, not files in `.github/workflows/`. Validate them with the CodeQL
> CLI before merging.

---

## Step 1 — Disable default setup

Repository → **Settings → Code security → Code scanning → CodeQL analysis →
Default setup → Disable**. (Or `gh api --method PATCH
repos/{owner}/{repo}/code-scanning/default-setup -f state=not-configured`.)

Nothing in the review pipeline breaks in the gap: with no analysis for a ref,
`fetchCodeqlSourceToSinkPaths` returns `{ status: 'unavailable' }` and the review
reports **not analyzed** rather than a false clean (ADR-039 S5a).

## Step 2 — Add the advanced workflow

Create `.github/workflows/codeql.yml`:

```yaml
name: CodeQL
on:
  push:
    branches: [main, "release/**"]
  pull_request:
    branches: [main, "release/**"]
  schedule:
    - cron: "23 3 * * 1"
permissions:
  security-events: write
  contents: read
jobs:
  analyze:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        language: [javascript-typescript, python, actions]
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: ${{ matrix.language }}
          config-file: ./.github/codeql/config.yml
      - uses: github/codeql-action/analyze@v3
```

## Step 3 — Add the config (security-extended + barrier packs)

Create `.github/codeql/config.yml`:

```yaml
name: BrainRouter CodeQL config
queries:
  - uses: security-extended
paths-ignore:
  - "**/dist/**"
  - "**/*.test.ts"
  - "**/tests/**"
  - "openSrc/**"
packs:
  javascript-typescript:
    - kinqs/brainrouter-barriers   # the D4 barrier model, Step 4
```

## Step 4 — Build the D4 barrier model pack

The barrier knowledge — which exported symbol neutralizes which vuln class — is
the source of truth in `adr039BarrierPack.ts`, kept honest by the parity test.
Render it into a CodeQL **data-extension** model pack:

- One extension row per barrier symbol, added to the JS/TS sanitizer/barrier
  extensible predicate for the symbol's vuln class (`ssrf`, `path-traversal`,
  `secret-exposure`, `prompt-injection`). Map a SARIF ruleId to its class with
  `barrierClassForRuleId`.
- The pack's `qlpack.yml` names it `kinqs/brainrouter-barriers` and lists
  `dataExtensions: [ '*.model.yml' ]`.

Validate the pack compiles and the barriers take effect **before** merging:

```bash
codeql pack install .github/codeql/brainrouter-barriers
codeql database analyze <db> --format=sarif-latest --output=out.sarif \
  codeql/javascript-queries:codeql-suites/javascript-security-extended.qls
```

## Step 5 — Confirm §6 "fixed code stays fixed"

Run the extended scan against `HEAD` after the SSRF fixes. The barrier model is
correct only if the scan does **not** re-report `brainrouter/src/providers/modelProbe.ts`
(guarded through `fetchUpstreamWithPolicy`) — §6's canonical probe. If it still
reports there, a barrier row is missing or too coarse: a barrier must dominate the
tainted path (the modelProbe fix guarded three of four paths — the fourth is the
real bug the engine must still catch), so model the exact guarded flow, never the
file. See the must-not-report set in `adr039ReplayCorpus.ts`.

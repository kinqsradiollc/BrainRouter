# 07 — Testing

Three test runners, split by workspace. The two things that trip people up:
**never Jest**, and **golden/parity tests fail in workspaces you didn't edit.**

---

### 1. Three runners, per workspace — never Jest

Match the workspace's existing runner:

| Workspace | Runner |
|---|---|
| `brainrouter/` (the brain) | **Vitest** for unit + `node:test` for PG integration (`"test": "vitest run && npm run test:integration"`) |
| `brainrouter-cli`, `packages/core`, `packages/agent-protocol`, `brainrouter-benchmark` | compile with `tsc` then `node --test "dist/**/*.test.js"` |
| `brainrouter-desktop` | `node --test "dist-electron/**/*.test.js"` (electron-main) + `tsx --test` over `src/**` (renderer) |

`jest`/`ts-jest` sit in root devDependencies but **no workspace uses Jest — do not
write Jest tests.** `brainrouter-dashboard`, `packages/hooks`, `packages/sdk`,
`packages/types` have **no `test` script** and are silently skipped by the root
`-ws --if-present` fan-out — adding a test script to one suddenly gates CI.

- **Why:** each runner matches the runtime of the code under test; a test for the
  wrong runner simply never executes.
- **Evidence:** `brainrouter/package.json`, `brainrouter-cli/package.json`, `package.json`

### 2. Test file locations are fixed per workspace

- Brain: `brainrouter/src/__tests__/` — `*.test.ts` (Vitest) and `*.node-test.ts`
  (integration).
- CLI: `brainrouter-cli/src/tests/`. Core: `packages/core/src/tests/`.
- Desktop: **colocated** next to source (`electron/foo.test.ts` beside `foo.ts`;
  `src/lib/**/bar.test.ts` beside `bar.ts`).
- Shared fixtures live in a `_helpers.ts` in the same tests dir — the underscore
  keeps it outside the `*.test.js` glob. Don't add a fixture there unless ≥2 files
  use it.
- **Why:** runners discover tests purely by glob; a test in the wrong dir/suffix
  is silently never run.
- **Evidence:** `brainrouter-cli/src/tests/_helpers.ts:1`, `brainrouter-desktop/electron/secretStore.test.ts`

### 3. ⛔ The `.node-test.ts` suffix is load-bearing in the brain

Name Postgres-touching integration tests `*.node-test.ts`, never `*.test.ts`. The
hyphenated suffix deliberately fails Vitest's `*.test.ts` glob so these run only
under `test:integration`:
`node --test --import ./dist/__tests__/helpers/test-teardown.js --test-concurrency=1 'dist/**/*.node-test.js'`.
Keep `--test-concurrency=1` (each file provisions scratch DBs) and don't remove the
`--import` teardown (it closes the lazy `memoryEngine` singleton so the process
exits without `--test-force-exit`).

- **Why:** renaming to `.test.ts` makes Vitest run a Postgres integration test in
  the unit pass; dropping the teardown leaks a pg pool and hangs the run.
- **Evidence:** `brainrouter/package.json:29`, `brainrouter/src/__tests__/helpers/test-teardown.ts`

### 4. Brain integration tests get a scratch Postgres DB per test via `pgTestStore`

Use `createTestStore()` / `createTestEngine()` from
`src/__tests__/helpers/pgTestStore.ts`: each call CREATEs a unique
`br_test_<ts>_<rand>` DB against the admin URL (env chain
`BRAINROUTER_TEST_PG_ADMIN_URL` → `BRAINROUTER_DATABASE_URL` → `DATABASE_URL` →
`postgres://postgres:postgres@localhost:5432/postgres`), runs migrations +
`initVec(8)`, and returns a `cleanup()` that drops it. Always wrap the body in
`try { … } finally { await cleanup(); }`. `createTestEngine()` disables the
background job runner by default — pass `{ jobRunner: true }` only if needed.

- **Why:** the suite runs against real pgvector (SQLite removed, ADR-007); per-test
  scratch DBs are the isolation mechanism; a racing job runner flakes assertions.
- **Evidence:** `brainrouter/src/__tests__/helpers/pgTestStore.ts`

### 5. `node:test` workspaces run COMPILED tests — build first, `.js` imports, tests stripped on publish

In CLI/core/agent-protocol/benchmark/desktop-electron, tests are TypeScript under
`src`, compiled to `dist`, and executed there — so every `test` script starts with
a build, relative imports use `.js` extensions (NodeNext), and a test that doesn't
compile doesn't run. `prepack` walks `dist` and deletes every `*.test.*` so tests
never ship — keep test files matching that `/\.test\./` name pattern.

- **Why:** running against `dist` catches NodeNext emit problems ts-jest would
  hide; stale builds silently run stale tests (hence the mandatory rebuild).
- **Evidence:** `brainrouter-cli/package.json`, `brainrouter-cli/tsconfig.json:13`

### 6. ⛔ Golden/parity tests pin enumerated surfaces — adding one breaks OTHER workspaces

Roles/agents, providers, and slash commands are pinned by exact-list "golden"
tests in multiple workspaces. Adding one requires updating **all** of:

- `packages/core/src/tests/agentRegistry.test.ts` —
  `assert.deepEqual(ids, ['architect','explorer','fleet','intake','reviewer','verifier','worker'])`
  and `listAll().length === 7`
- `brainrouter-cli/src/tests/catalog-parity.test.ts` — same role list +
  `validateCatalogParity(SLASH_COMMANDS, HELP_CATEGORIES)`
- `brainrouter-desktop/src/lib/commands/catalog-parity.test.ts` — every catalog
  command resolves to a route, no orphan WIRED entries
- `packages/core/src/tests/provider-catalog.test.ts` — exact
  endpoint/envKey/pickerVisible table

After adding any enumerated thing, grep all workspaces' tests for
count/`deepEqual` assertions and run the affected parity tests locally. The
complete root suite remains a required hosted CI merge gate; run it locally when
the change is cross-cutting/high-risk or while diagnosing CI parity. Parity
validators include a negative control that injects `/ghost-command` to prove the
check works — keep that pattern when writing new validators.

- **Why:** these tests catch drift between tab-completion, `/help`, the desktop
  router, and the registry; a contributor who runs only the workspace they edited
  ships a red CI in one they never touched.
- **Evidence:** `packages/core/src/tests/agentRegistry.test.ts`, `packages/core/src/command/parity.ts`

### 7. Isolate CLI/core tests with `withTempWorkspace` — and know `BRAINROUTER_HOME` does NOT cover the XDG config

Any CLI/core test touching workspace files, config, or the Agent runs inside
`withTempWorkspace`/`withTempWorkspaceAsync` from the local `_helpers.ts`: it
mkdtemps a workspace + fake home, pins `BRAINROUTER_HOME`, chdirs in, and in
`finally` restores cwd/env, calls `_resetCliKnobsCache()`, and deletes both dirs.
**Critically, the real user config lives at `~/.config/brainrouter/config.json`
(XDG), which `BRAINROUTER_HOME` does not redirect** — core's helper also calls
`setCliKnobOverride({ providerRequestFormat: {} })` so a developer's local
provider-format override can't leak into stubbed Chat-Completions tests. Never
reset knobs on helper *entry* (tests compose `setCliKnobOverride` before calling
the helper).

- **Why:** local config leakage has caused tests to fail only on the developer's
  machine (an `openai→responses` override breaking ~6 runtime/orchestration tests);
  resetting on entry would clobber per-test knob composition.
- **Evidence:** `packages/core/src/tests/_helpers.ts:19,55`, `brainrouter-cli/src/tests/_helpers.ts:41`

### 8. Testability via exported underscore seams, not module mocking

In node:test workspaces, production modules expose explicit test seams
(`_resetCliKnobsCache`, `_resetConfigCache`, `_resetContextWindowCache`,
`__resetBackgroundShells`, `_setSafeStorageForTests`) and tests inject fakes via
constructor/params. There is **no module-mocking framework** in these workspaces —
add a `_reset*`/`_set*ForTests` export when a module holds cached singleton state.
`vi.mock` is used ONLY in the brain's Vitest unit tests (e.g. mocking
`../memory/engine.js` in API-route tests). In the brain, keep tiers strict:
Vitest `*.test.ts` tests pure logic and mocks the engine; anything needing real
SQL goes in a `*.node-test.ts` — never instantiate `PostgresMemoryStore` in a
Vitest file.

- **Evidence:** `packages/core/src/config/config.ts:695`, `brainrouter/src/__tests__/api-routes.test.ts:7`

### 9. Network mocking: swap `globalThis.fetch` (restore in `finally`) or spin a raw TCP SSE server

CLI tests hitting HTTP replace `globalThis.fetch` with an inline async stub and
restore the original in `finally` — no nock/msw. For streaming, spin up a raw
`node:net` server emitting canned SSE frames and deliberately split frames
mid-JSON across TCP writes to stress the parser's chunk-boundary handling; listen
on port 0 / 127.0.0.1 and close when done.

- **Why:** SSE parsers historically broke when a delta arrived split across two TCP
  reads; an http-level mock can't control chunk boundaries.
- **Evidence:** `brainrouter-cli/src/tests/streaming.test.ts:8`, `brainrouter-cli/src/tests/mcp.test.ts:164`

### 10. Assertion style + temp dirs

- `import test from 'node:test'; import assert from 'node:assert/strict';`. Flat
  `test('full-sentence description', …)` calls, generally no `describe` blocks.
- Give assertions a trailing message explaining intent. For "no offenders",
  collect them and `assert.deepEqual(offenders, [])` so the failure names the
  culprits (not `assert.ok(list.length === 0)`).
- Test titles carry the task/feature ID they guard (`MEM-32 …`, `T16 GOLDEN …`).
- Temp dirs: `fs.mkdtempSync(path.join(os.tmpdir(), '<prefix>-'))`, cleaned with
  `fs.rmSync(dir, { recursive: true, force: true })` in `finally`. When the code
  resolves symlinks, wrap in `fs.realpathSync` (macOS `/tmp` → `/private/tmp`).
- **Evidence:** `brainrouter-desktop/src/lib/commands/catalog-parity.test.ts:30`, `brainrouter-desktop/electron/fsRead.test.ts:15`

---

## Running suites & CI

### 11. Run suites from the root; Postgres required for the brain

Canonical invocation is root `npm run test` (`= npm run test -ws --if-present`),
typically after root `npm run build`; `npm run verify` chains typecheck + lint +
test. Workspaces without a test script are skipped. To run the brain's integration
tests you need a reachable pgvector Postgres — set `BRAINROUTER_TEST_PG_ADMIN_URL`/
`BRAINROUTER_DATABASE_URL` or run default docker creds
(`postgres:postgres@localhost:5432`). **Per-workspace runs miss cross-workspace
golden tests**, so enumerate and run the affected parity checks locally and
require the complete hosted suite before merge. Use local `npm run verify` for
cross-cutting/high-risk work, release/publish work, or CI-parity diagnosis.

- **Evidence:** `package.json`, `brainrouter/src/__tests__/helpers/pgTestStore.ts:33`

### 12. CI: single Node 22.x job in `.github/workflows/ci.yml` with a pgvector service — don't add Node 20

CI is one build-and-test job on **Node 22.x only** (comment forbids 20.x:
`node:sqlite` history landed in 22.5, `node --test` glob expansion is 22+, and a
JWT test relies on Node 22 crypto behavior). It provisions a `pgvector/pgvector:pg16`
service, exports `BRAINROUTER_DATABASE_URL` + `BRAINROUTER_TEST_PG_ADMIN_URL`,
installs with `npm ci` under `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, builds ALL
workspaces before testing, and sets `NODE_NO_WARNINGS=1`. **The root `.ci.yml` is a
stale copy without the Postgres service — edit `.github/workflows/ci.yml`.**

- **Why:** tests import compiled `dist`, so build-before-test is mandatory;
  widening the Node matrix without reworking the three 22-only dependencies fails
  immediately.
- **Evidence:** `.github/workflows/ci.yml`, `.ci.yml`

### 13. Pre-commit hook lints staged files only — tests/formatting are NOT in it

`.githooks/pre-commit` (wired via `core.hooksPath=.githooks` by the root `prepare`
script) runs ESLint on **only** the staged `.ts/.tsx/.js/.mjs/.cjs` files
(excluding dist/dist-electron/node_modules). It deliberately does NOT run
`prettier --write` (tree churn) or any build/test (too slow), skips gracefully if
eslint is missing, and is bypassable with `--no-verify` or `BR_SKIP_HOOKS=1`. Don't
add heavyweight steps — focused local checks provide iteration feedback, and
hosted CI is the full merge gate. The root `verify` script remains available for
cross-cutting/high-risk work, release/publish work, and CI-parity diagnosis.

- **Evidence:** `.githooks/pre-commit`, `scripts/install-git-hooks.mjs`, `.githooks/README.md`

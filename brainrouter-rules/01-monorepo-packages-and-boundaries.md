# 01 — Monorepo, Packages & Boundaries

How the workspaces depend on each other, how they build, and the import
boundaries that keep it all buildable and browser-safe.

## Workspace map

- **Leaves:** `@kinqs/brainrouter-types`, `@kinqs/brainrouter-agent-protocol`
- **Core:** `@kinqs/brainrouter-core` (depends only on types + agent-protocol,
  MCP SDK, cheerio)
- **SDK/hooks:** `@kinqs/brainrouter-sdk` (depends on types),
  `@kinqs/brainrouter-hooks` (depends on sdk + types)
- **Apps:** `brainrouter` (MCP server), `brainrouter-cli`, `brainrouter-desktop`,
  `brainrouter-dashboard`, `brainrouter-benchmark`

---

### 1. Respect the layered dependency direction: leaves → core → apps, never backwards

Types and agent-protocol are leaves; core depends only on them; apps consume
packages. **Packages never import from apps.** When a package needs a shape that
originates in an app (e.g. the CLI's `RunTurnCallbacks`), define it
*structurally* in the package rather than importing the app.

- **Why:** keeps every package independently buildable and publishable.
- **Evidence:** `packages/agent-protocol/src/index.ts:1` (header states it mirrors
  the CLI callbacks structurally to stay a leaf), `packages/core/package.json`,
  `packages/sdk/package.json`, `packages/hooks/package.json`

### 2. Build packages in the root-defined order before apps

`npm run build:packages` builds types → agent-protocol → core → sdk → hooks; then
`build:apps`. Workspaces resolve each other via compiled `dist/`, so **after
editing a package you must rebuild it before building/testing anything
downstream.** Never reorder the `build:packages` chain.

- **Why:** a dependent workspace compiles against the dependency's *stale* `dist`;
  skipping the rebuild gives confusing type errors or silently stale behavior.
- **Evidence:** `package.json:14-17`

### 3. ⛔ Import core only via curated per-subsystem entrypoints; `dist/*` is an ESLint error

Import core as `@kinqs/brainrouter-core/<subsystem>` (`/agent`, `/config`,
`/memory`, `/provider`, `/exec`, or a focused browser-safe subpath). The root
ESLint config makes
`@kinqs/brainrouter-core/dist/**` a `no-restricted-imports` **error**. Node
and renderer consumers use only curated entrypoints.

- **Why:** the migration off 442 deep `dist` imports is complete; deep imports
  couple consumers to core's internal file layout and reopen the god-package
  problem.
- **Evidence:** `eslint.config.mjs:51`, `packages/core/package.json`

### 4. New core subsystem = `index.ts` entrypoint + a `package.json` exports entry

When adding a subsystem under `packages/core/src/<domain>/`, create an
`index.ts` barrel with the standard header, re-export **only** what the CLI/
Desktop heads consume, and add a matching `"./<domain>"` entry (types + default
pointing at `dist`) to core's `package.json` exports map. Directories without an
`index.ts` (`lsp/`, `research/`, `websearch/`, `ui/`, `tests/`) are deliberately
internal and absent from the exports map.

- **Why:** the exports map is the machine-readable public API; a subsystem without
  an exports entry is unreachable through the sanctioned import style.
- **Evidence:** `packages/core/src/memory/index.ts:1`, `packages/core/src/agent/index.ts:1`,
  `packages/core/package.json`

### 5. Keep internal service layers out of subsystem entrypoints; the root barrel stays empty

A subsystem entrypoint exports a *curated* surface, not everything in the folder
(several barrels explicitly note "the internal service layer (`service.ts`) stays
unexported"). Do **not** blanket `export * from './service.js'`. And
`packages/core/src/index.ts` exports only the `CORE_PACKAGE` constant — **never
fatten the root barrel.** Source is organized by DOMAIN (`provider/`, `agent/`,
`tool/`, `session/`, …), not by layer.

- **Why:** a fat root barrel is what produced the original god-package (an empty
  barrel forced 442 deep imports; the fix was per-subsystem entrypoints). A fat
  root would also drag node-only modules into any browser bundle touching core.
- **Evidence:** `packages/core/src/index.ts:24`, `packages/core/src/memory/index.ts:3`,
  `packages/core/src/agent/index.ts:1`

### 6. ⛔ Browser-safe Core access uses focused curated subpaths

The Vite renderer must not import a broad Core subsystem barrel when that barrel
also exposes Node-only modules. Add or reuse a focused, explicitly exported
browser-safe subpath such as `workspace/profiles`, `write/review-diff`, or
`session/permission-modes`. Never restore the `./dist/*` wildcard or import a
compiled internal path.

- **Why:** focused exports keep browser bundles away from `node:fs` and
  `node:crypto` without coupling consumers to Core's file layout.
- **Evidence:** `packages/core/package.json`, `eslint.config.mjs`,
  `brainrouter-desktop/src/panels/EditorPanel/useMarkdownMode.ts`

### 7. The dashboard may only use the browser-safe package subset

`brainrouter-dashboard` depends on **types + sdk + hooks only** — never on core
or agent-protocol. The dedicated `build:packages:dashboard` script builds exactly
those three. Adding a core dependency to dashboard code breaks the scoped
(Cloudflare) build, which never compiles core.

- **Why:** the CF pipeline installs and builds only the browser-facing subset;
  core pulls `node:fs`/`node:crypto` and cannot ship to the browser.
- **Evidence:** `package.json:16`, `brainrouter-dashboard/package.json`

### 8. In `@kinqs/brainrouter-types`, keep runtime values crypto-free in dedicated modules

The types package is mostly type-only, but its runtime values must be
browser-importable: put runtime constants/helpers in their own module with
type-only imports (e.g. `memory-type-list.ts`'s `import type { MemoryType }` +
`satisfies`-checked list). Never add a value import that reaches
`memory/records.ts`, which has a top-level `import { createHash } from "node:crypto"`
— so the package **root barrel is NOT browser-safe** and browser bundles import
subpaths directly.

- **Why:** one transitive `node:crypto` import breaks the vite build.
- **Evidence:** `packages/types/src/memory-type-list.ts:1`, `packages/types/src/memory/records.ts:133`

### 9. Package flavors: tsconfig, ESM, and test-strip conventions

- All packages are `"type": "module"`, tsconfig `module`/`moduleResolution` =
  NodeNext, `declaration: true`, `outDir: "dist"`, `strict: true`,
  `skipLibCheck: true`, `include: ["src"]`. Node-side packages (core,
  agent-protocol) pin `rootDir: "src"` + `"types": ["node"]`; hooks adds
  `"jsx": "react-jsx"`; browser-facing packages (types, sdk, hooks) do **not**
  declare node types. Build is plain `tsc -p tsconfig.json`.
- Package tests use `node:test` + `node:assert/strict` (no Jest/Vitest in
  `packages/`), compiled and run against `dist` (`node --test "dist/**/*.test.js"`).
- Packages with tests run a `prepack` that builds then deletes every `*.test.*`
  from `dist` so tests never ship; also a `clean` (rm dist) so renamed files
  don't linger.
- **Evidence:** `packages/core/tsconfig.json`, `packages/core/package.json`,
  `packages/agent-protocol/package.json`

### 10. Package-specific purity rules

- **agent-protocol** stays a **zero-dependency pure leaf** — no runtime deps, no
  `@kinqs` imports, shapes duplicated structurally, hand-rolled type guards
  (`isAgentCommand`), no I/O. It's the one vocabulary shared across in-process
  callbacks, JSONL stdout, and Electron IPC.
- **hooks** keeps React a **peerDependency** (`^18.3.1 || ^19.0.0`), never a
  regular dep; each hook takes the `BrainRouterClient` as an explicit parameter
  (no context/module-global); one `use*.ts` per file.
- **sdk** is **fetch-only and browser-safe** (no `node:` builtins); every request
  funnels through one private `request<T>()` (single place for auth headers +
  the transparent refresh-on-401 via injectable `onUnauthorized`); errors thrown
  as `BrainRouterApiError`; config uses `withApiKey`/`withToken` copy-constructors.
- **Evidence:** `packages/agent-protocol/src/index.ts:1`, `packages/hooks/package.json`,
  `packages/sdk/src/client.ts:60,104`

### 10a. Shared data contracts live in types; wire events live in agent-protocol

When a dependency-free record, reference, status union, or stable payload
constant crosses package/process boundaries, define it in
`@kinqs/brainrouter-types` and add a browser-safe subpath when renderer consumers
need it. Agent-host commands, events, and delivery vocabulary instead belong in
the zero-dependency agent-protocol leaf. Core imports those contracts and owns
validation, domain transitions, services, and adapters behind thin subsystem
entrypoints; never combine all of those responsibilities into one contract
module. Filesystem, process, provider, Electron, or secret-bearing interfaces
remain in owning-package ports and must not enter the browser-safe types leaf.

- **Why:** putting shared shapes beside core validation/storage forces other
  packages to depend on implementation details and turns each new workflow field
  into god-file growth; moving side-effect ports into types would break leaf
  purity in the opposite direction.
- **Evidence:** `packages/types/src/work-contract.ts`,
  `packages/core/src/task/workContract.ts`,
  `packages/core/src/task/workContractValidation.ts`

### 11. Lockstep versioning; version strings read from `package.json` at runtime

Every publishable package **and** every private app carries the SAME version
(inter-package deps pin `^<that version>`, not `workspace:`). Only private
`brainrouter-benchmark` is exempt. Never bump one package independently. Read the
version via a `version.ts` that loads the package's own `package.json` relative to
`import.meta.url` at load, exporting a single `VERSION` const — **never hardcode
version literals** in banners, clientInfo, or telemetry.

- **Why:** publishing in dependency order relies on each package's deps
  referencing the real semver of what published before it; hardcoded versions rot
  (a banner said `0.3.8` while packages were 0.4.x).
- **Evidence:** `package.json:4`, `packages/core/src/version.ts:1`

> Full build/publish mechanics (order, `prepack`/`postpack` bundling, npm auth)
> are in [`08-git-release-and-changelog.md`](08-git-release-and-changelog.md).

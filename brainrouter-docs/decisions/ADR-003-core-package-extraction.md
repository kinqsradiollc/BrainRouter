# ADR-003 — Extract a shared `@kinqs/brainrouter-core` package from the CLI

> Status: **COMPLETE — all batches 0–7 DONE (CI-green). Desktop→CLI coupling 49 → 0; the CLI dependency is removed from the Desktop. NOT committed (user commits manually).**
>
> **Follow-up (2026-06-19, NOT committed) — domain reorganization.** The package
> first landed mirroring the CLI's old layer folders (a `runtime/` grab-bag, a
> flat `state/`, CLI-flavored `cliState`). It was then reorganized by DOMAIN into
> **32 categories** — `provider/` (its own first-class category, per the "more
> providers coming" requirement), `agent/ tool/ orchestration/ session/ storage/
> config/ mcp/ lsp/ exec/ memory/ prompt/ telemetry/ command/ context/ goal/
> task/ review/ requirement/ annotation/ artifact/ attachment/ background/
> workflow/ worker/ schedule/ hooks/ pack/ git/ workspace/ worktree/ util/`.
> Done with a deterministic reorg tool (`scripts-reorg/reorg.mjs`: takes an
> old→new path map, moves the core source, and rewrites every core-relative
> import + every CLI-shim/Desktop `@kinqs/brainrouter-core/dist/<path>.js`
> specifier). `cliState` → `storage/store`; `getCliState{Dir,File}` →
> `getState{Dir,File}` (no CLI-isms in a shared package; `cliPrompter` correctly
> stays in the CLI as the TTY impl of the core `InteractivePrompter` port).
> Asset-readers (`config/configLoader`, `orchestration/agentRegistry`,
> `pack/packs`) stayed at depth-2 so `../../{config,agents,packs}` still resolve.
> All green: core 42 · CLI 1560 · desktop electron 73 + renderer 210; root build clean.
> Date: 2026-06-19. Supersedes the ad-hoc "Desktop reaches into the CLI's `dist/`"
> arrangement.
>
> **Progress (2026-06-19, NOT committed):** `@kinqs/brainrouter-core` created + wired
> (Batch 0). Migrated leaf-first with CLI re-export shims + desktop import flips,
> each batch CI-green (core+cli+desktop builds + tests):
> - **Batch 1:** `state/cliState`, `runtime/{cronParser,commandRegistry}`,
>   `orchestration/{reviewModel,reviewFindings}`, `telemetry/contracts`,
>   `config/{permissionRules,workspaceGit}`.
> - **Batch 2:** `config/config` (+ `runtime/exec/{execPolicy,approvalGuard}`),
>   `config/agentModels`. (exec cycle `sandbox`/`commandPolicy`/`dangerousCommand`
>   stays CLI-only, as planned.)
> - **Batch 3 (folded in ADR Batch 4):** all 25 `state/*` stores
>   (`sessionStore`, `taskStore`, `goalStore`, `backgroundTaskStore`,
>   `preferencesStore`, `sessionModeStore`, `planHistoryStore`, … ).
> - **Batch 5a:** `telemetry/{telemetryPort,fileTelemetryAdapter,telemetry}`,
>   `attachments/{imageMeta,pdfText,detect,ingest}`, `runtime/{usageBreakdown,
>   catalogParity,configLoader,lmStudioApi,tracing,contextWindow,reconnect,
>   mcpClient,mcpPool,mcpUtils}`, `version`, `state/checkpointStore`,
>   `orchestration/memoryEvents`. **Asset fix:** copied `config/{providers,models,
>   api-key-prefixes}.json` → `packages/core/config/` (configLoader resolves
>   `<pkg>/config`); added `config` to core's `files`. 4 co-located tests
>   (`telemetry`,`imageMeta`,`pdfText`,`detect`) moved to core → run by `npm test
>   -w @kinqs/brainrouter-core` (42 tests). CLI 1602→1560 (+42 in core = 1602).
>
 - **Batch 6a:** `orchestration/{outputContracts,packs,roles,agentRegistry,
>   orchestrator,parentContext}`, `state/packStore`, `runtime/{backgroundTasks,
>   backgroundReconcile}`. **Asset fix:** copied `agents/` + `packs/` →
>   `packages/core/` (agentRegistry resolves `../../agents`, packs resolves
>   `../../packs` from `import.meta.url`); added both to core's `files`.
> - **Batch 6b (the AGENT):** the full 80-module `agent.ts` closure
>   (`agent/*`, `agent/repair/*`, `agent/tools/*`, `prompt/*`, `memory/{anchorPin,
>   briefing,briefingTriggers,memoryPolicy}`, `orchestration/{tools,workerTools,
>   router,synthesis,…}`, `runtime/{exec/*,lsp/*,tierLadder,modelFallback,…}`,
>   `state/{completionInbox,fileSnapshotStore,hookifyStore}`, `config/workspace`).
>   **INJECTION SEAM:** `agent.ts` no longer imports `cli/cliPrompt`; it asks
>   through an injected `InteractivePrompter` (new `core/src/agent/prompter.ts` —
>   `NoTTYError` + interface + `HEADLESS_PROMPTER`). The CLI injects `cliPrompter`
>   (TTY-backed, in `cli/cliPrompt.ts`) at its `new Agent(...)` sites; the Desktop
>   + children + tests use the headless default. `NoTTYError` lives in core;
>   `cli/cliPrompt` re-exports it (one class → `instanceof` stays valid).
> - **Batch 7 (catalog + finalize):** `cli/wizard/providers.ts` →
>   `core/config/providers.ts`; `buildGoalKickoffPrompt` → `core/state/goalKickoff.ts`;
>   `SLASH_COMMANDS`/`HELP_CATEGORIES`/`HelpEntry`/`HelpCategory` extracted from
>   `cli/repl.ts` → `core/commandCatalog.ts` (REPL imports+re-exports them).
>   **Removed `@kinqs/brainrouter-cli` from the Desktop's dependencies** + dropped
>   the CLI build from its `build:deps` (builds `types`+`core` only).
>
> **RESULT: desktop→CLI `dist/` imports = 0; the Desktop depends only on
> `@kinqs/brainrouter-core` + `@kinqs/brainrouter-agent-protocol`. 151 modules in
> core. Root `npm run build` green; core 42 + CLI 1560 + desktop electron 73 +
> renderer 210 all pass.** Remaining (optional, deferred): collapse the ~150 CLI
> re-export shims by pointing the CLI's own importers straight at the package.
>
> **ASSET-RESOLUTION RULE (learned the hard way):** any module that reads a
> BUNDLED asset dir via `import.meta.url` (`config/`, `agents/`, `packs/`)
> resolves it relative to its own `dist/` location, so the dir MUST be copied
> into `packages/core/` and added to core's `files`. A missing asset throws at
> import time → whole test FILES fail to load (count drops + many "not ok").
> **GOTCHA:** the dep scan must also catch INLINE-TYPE imports
> (`x?: import('./mod.js').Type`) and dynamic `import('./mod.js')` — a plain
> `grep "from '...'"` misses them (this bit `orchestrator.ts`'s `parentContext`).
>
> **Desktop→CLI coupling: 49 → 0 modules — DONE (see Batches 6b + 7 above).**
> **Gate (run every batch):** `npm run build -w @kinqs/brainrouter-core && npm run
> build -w @kinqs/brainrouter-cli && npm --prefix brainrouter-desktop run build &&
> npm test -w @kinqs/brainrouter-cli && npm test -w @kinqs/brainrouter-core`.

## Context

The Desktop app does not depend on a published BrainRouter library — it
**deep-imports build artifacts straight out of the CLI's compiled output**. A
sweep of the Desktop tree finds **49 distinct `@kinqs/brainrouter-cli/dist/<area>/<mod>.js`
import paths** across the Electron host, the main process, the session-mode
bridge, and one renderer test. These span config, state stores, runtime,
orchestration, telemetry, the agent, and the slash-command catalog.

This couples two products that are supposed to be peers:

- **CLI-is-CLI** — a terminal program with an interactive TTY, readline prompts,
  a REPL, and slash commands.
- **Desktop-is-Desktop** — an Electron host that drives the same headless
  engine through its own UI.

Today the "shared engine" only exists as a side effect of the CLI's `dist/`
layout. Problems this creates:

- **No real boundary.** Any CLI refactor that renames or relocates a `dist/`
  path silently breaks the Desktop build. The shared surface is implicit and
  unversioned.
- **`dist/` is a build artifact, not source.** It is gitignored repo-wide (0
  tracked files), so the Desktop consumes output that must be freshly built at
  CI time, in dependency order, with no package contract enforcing it.
- **Leakage of CLI-only concerns.** Some imports pull interactive-terminal code
  (the REPL, readline prompts) into a process that has no TTY.

The fix is **one** shared package that both products depend on as a normal
workspace dependency — not a CLI-internal `dist/` reach-through. We size that
package to *exactly the Desktop surface* and migrate leaf-first so every batch
ends with all three builds green.

### Ground-truth findings that shape the plan

- `config/config.ts`'s two `process.exit` calls live inside `loadConfig`'s
  missing-file / error path — **not at module load**. The module is safe to
  `import` from Electron; no injection refactor is required to move it.
- `agent/agent.ts` imports an interactive prompter from the CLI's interactive
  layer (`agent.ts:12`). This is the **one genuine injection seam** in the whole
  migration — it must become an injected port, not a moved file.
- The live runtime dependency **cycle** (`runtime/exec/commandPolicy ⇄
  runtime/exec/dangerousCommand`) and the `config ⇄ runtime/exec/sandbox`
  coupling are **not imported by the Desktop at all**. They stay in the CLI and
  never cross the package boundary.
- `state/preferencesStore.ts` pulls only the raw-CLI-knobs accessor from config.
- The existing leaf package (`packages/agent-protocol`) is the clone template;
  it ships a single barrel (`main: dist/index.js`) with **no `exports` map**, so
  deep subpath imports are not gated. The new package will add an `exports`
  wildcard so deep `dist/` subpaths resolve cleanly under NodeNext.
- The root `build:packages` script lists packages flat (it does not order by
  dependency depth); `core` must be inserted **after** `types`.

## Decision

Create **one** new workspace package:

**`@kinqs/brainrouter-core`** — the headless engine shared by the CLI and the
Desktop. It contains **only** the modules the Desktop actually imports, plus the
minimal pure leaves those modules require to compile. Everything else stays in
the CLI.

Rationale for a single package (not a `core` + `agent` split):

- The Desktop's need is one cohesive "headless engine," not two version-locked
  layers. A split doubles the package.json / tsconfig / CI wiring and forces two
  boundaries to rev together, while the Desktop main process would still depend
  on *both* — buying nothing here.
- It matches the existing `types → agent-protocol` precedent: small, single,
  acyclic.

### What moves vs. what stays

**Moves into `@kinqs/brainrouter-core`** (the Desktop surface + its required
leaves): the `config` near-leaf (`config.ts`, `agentModels.ts`,
`permissionRules.ts`, `workspaceGit.ts`) and the two pure exec leaves it needs
(`runtime/exec/execPolicy.ts`, `runtime/exec/approvalGuard.ts`); the `state`
store cluster that fans out from `cliState.ts`; the pure runtime/orchestration/
telemetry leaves (`cronParser`, `commandRegistry`, `reviewModel`,
`reviewFindings`, `contracts`); and, at the tail, the orchestrator / background
/ agent cluster (the agent via an injected prompter port) plus the
slash-command/provider catalog the Desktop reads.

**Stays CLI-only** (see "What explicitly stays CLI-only" below): the interactive
terminal layer and everything that carries the exec cycle.

### Migration mechanic (applies to every batch)

For each moved module:

1. Physically move `brainrouter-cli/src/<area>/<mod>.ts` →
   `packages/core/src/<area>/<mod>.ts`.
2. Leave a one-line CLI re-export shim at the old path:
   `export * from '@kinqs/brainrouter-core/dist/<area>/<mod>.js';`
   so the ~700 internal CLI importers and the existing CLI tests stay untouched.
3. Flip the Desktop import site(s) for that module in the **same** batch: swap
   the `brainrouter-cli` prefix for `brainrouter-core`, keeping the identical
   subpath and `.js` suffix.

**Verification gate — run after every batch (must be green to proceed):**

```
npm run build -w @kinqs/brainrouter-core && \
npm run build -w @kinqs/brainrouter-cli && \
npm --prefix brainrouter-desktop run build && \
npm test -w @kinqs/brainrouter-cli
```

**Per-batch invariant:** a module may move only when *all* of its internal
dependencies already live in `core`. After batches that touch config/exec, also
run `madge --circular packages/core/dist` and confirm no cycle entered the
package.

## Migration order (leaf-first, numbered batches)

Execute "batch N" directly from the heading. Each batch lists the modules,
their target, the import-site updates, and ends at the build+test gate above.

### Batch 0 — Scaffold (no module moves)

- **Create** `packages/core/` by cloning `packages/agent-protocol/`:
  - `package.json`: name `@kinqs/brainrouter-core`, version matched to the
    current release line, dep `@kinqs/brainrouter-types: ^<release>`,
    `files: ["dist"]`, and **add**
    `"exports": { ".": "./dist/index.js", "./*": "./dist/*" }` so deep `dist/`
    subpath imports resolve under NodeNext.
  - `tsconfig.json`: clone agent-protocol's (ES2022 / NodeNext / `declaration` /
    `rootDir: src` / `outDir: dist` / `types: ["node"]`; **no** `jsx`).
  - Empty `src/index.ts`.
- **Wire root:** the `packages/*` workspace glob already covers it — `npm install`.
  Insert into root `package.json` `build:packages`, right after types:
  `… -w @kinqs/brainrouter-types && npm run build -w @kinqs/brainrouter-core && npm run build -w @kinqs/brainrouter-sdk …`
- **Add the dependency** `"@kinqs/brainrouter-core": "^<release>"` to **both**
  `brainrouter-cli/package.json` and `brainrouter-desktop/package.json`. Update
  the Desktop `build:deps` to build `core` before the CLI.
- **Import-site updates:** none.
- **Checkpoint:** gate green by construction — proves the dist wiring + Desktop
  resolution of an **empty** package before any code moves.

### Batch 1 — Foundation leaf + pure zero-dependency leaves

- **Modules → `packages/core/src/`:**
  - `state/cliState.ts` (zero internal deps — unblocks ~20 stores)
  - `runtime/cronParser.ts`, `runtime/commandRegistry.ts` (pure)
  - `orchestration/reviewModel.ts` (only `node:crypto`),
    `orchestration/reviewFindings.ts` (zero imports)
  - `telemetry/contracts.ts` (pure event names)
  - `config/permissionRules.ts`, `config/workspaceGit.ts` (pure; this is the
    `config/permissionRules.ts` with the rule-edit helper — distinct from
    `runtime/exec/permissionRules.ts`, which stays in the CLI)
- **Import-site updates:**
  - Desktop: flip the directly-imported ones in the host + main process —
    `state/cliState.js`, `runtime/cronParser.js`, `orchestration/reviewModel.js`,
    `orchestration/reviewFindings.js`, `telemetry/contracts.js`,
    `config/permissionRules.js`, `config/workspaceGit.js` (only flip a path that
    is *directly* imported; transitive-only ones flip when their importer moves).
  - CLI: each moved file becomes a re-export shim.
  - Leave the renderer `catalog-parity` test on the CLI for now — it reads the
    slash-command catalog from the REPL, which does not move until the tail.
- **Checkpoint:** gate.

### Batch 2 — Config near-leaf + its two exec leaves + agent models

- **Modules → `packages/core/src/`** (in dep order):
  - `runtime/exec/execPolicy.ts`, `runtime/exec/approvalGuard.ts` — both
    zero-import and pure; the *only* exec modules `config.ts` needs (it uses one
    type from `execPolicy` and one sanitizer from `approvalGuard`).
  - `config/config.ts` — all internal deps now satisfied; its `process.exit`
    calls are inside `loadConfig`'s error path, safe under Electron.
  - `config/agentModels.ts`.
  - **Explicitly NOT moved:** `runtime/exec/sandbox.ts`,
    `runtime/exec/commandPolicy.ts`, `runtime/exec/dangerousCommand.ts`, and the
    `runtime/exec/index.ts` barrel — they carry the `commandPolicy ⇄
    dangerousCommand` cycle and the `config ⇄ sandbox` coupling, and the Desktop
    imports none of them. They stay in the CLI and import `config` / `execPolicy`
    / `approvalGuard` **across** the boundary (one-way `cli → core`, acyclic).
- **Import-site updates:**
  - Desktop: flip `config/config.js` and `config/agentModels.js` in the host.
  - CLI: shims for `config.ts`, `agentModels.ts`, `execPolicy.ts`,
    `approvalGuard.ts`. The CLI's `sandbox.ts` / `commandPolicy.ts` now reach
    `config` / `execPolicy` / `approvalGuard` via the unchanged shim paths — no
    churn.
- **Checkpoint:** gate **plus** `madge --circular packages/core/dist`.

### Batch 3 — Stores that depend only on `cliState` (the big Desktop fan-out)

- **Modules → `packages/core/src/state/`** (all internal deps now in core):
  - `sessionStore.ts`, `taskStore.ts`, `goalStore.ts`, `scheduleStore.ts`,
    `sessionMetaStore.ts`, `sessionRuntimeStore.ts`, `workspaceTrust.ts`,
    `hooksStore.ts`, `requirementStore.ts`, `annotationStore.ts`,
    `artifactStore.ts`, `attachmentStore.ts`, `backgroundTaskStore.ts`,
    `workerStore.ts`, `workflowArtifacts.ts`
  - Type-only consumers of the above: `annotationExport.ts`, `chapterMarks.ts`,
    `transcriptSearch.ts`, `transcriptExport.ts`, `sessionRecap.ts`
  - `reviewStore.ts` (needs `cliState` + `reviewModel` — both in core),
    `workflowRun.ts` (needs `workflowArtifacts` — in core)
- **Import-site updates:**
  - Desktop: flip the large host store block + main-process store imports for
    every module above (pure prefix swap, subpaths identical).
  - CLI: a re-export shim per moved file; the hundreds of intra-CLI store
    importers and the modified state/goal tests on this branch keep passing
    untouched via the shims.
- **Checkpoint:** gate.

### Batch 4 — Config-coupled stores

- **Modules → `packages/core/src/state/`:** `preferencesStore.ts` (needs only
  the raw-CLI-knobs accessor from config — now in core), `sessionModeStore.ts`,
  `planHistoryStore.ts`, and any remaining store whose only outstanding
  dependency was `config` / a Batch-3 store.
- **Import-site updates:** Desktop flips these store paths (host + session-mode
  bridge); CLI shims each.
- **Checkpoint:** gate.

### Batch 5 — MCP + tracing + context-window cluster

- **Modules → `packages/core/src/`:** the `runtime` cluster the Desktop imports
  but that was blocked on config/stores — `contextWindow.ts`, `usageBreakdown.ts`,
  `mcpPool.ts`, `mcpUtils.ts`, `catalogParity.ts`, plus `telemetry/telemetry.ts`
  and the attachment-ingest path. Apply the asset-path fix in the config/asset
  loader so resolved paths work from the package location rather than the CLI's.
- **Import-site updates:** Desktop flips these; CLI shims each.
- **Checkpoint:** gate.

### Batch 6 — Orchestrator + background + agent (with the injection seam)

- **Modules → `packages/core/src/`:** `orchestration/orchestrator.ts`,
  `orchestration/memoryEvents.ts`, `runtime/backgroundTasks.ts`,
  `runtime/backgroundReconcile.ts`, `agent/agent.ts`,
  `agent/verificationGate.ts`.
- **Refactor (not a move) — the one genuine seam:** replace `agent.ts`'s import
  of the CLI interactive prompter (`agent.ts:12`) with an injected
  `InteractivePrompter` port (e.g. `askChoice` / `askYesNo` /
  `getActiveReadline` / `NoTTYError`). The CLI constructs and injects the real
  TTY-backed prompter; the Desktop injects its own. The agent module itself no
  longer references the CLI interactive layer.
- **Import-site updates:** Desktop flips the agent / orchestrator / background
  paths and supplies its prompter implementation; CLI shims each moved file and
  wires its prompter at the call site.
- **Checkpoint:** gate.

### Batch 7 — Catalog extraction + drop the CLI dependency

- **Modules → `packages/core/src/`:** extract the slash-command / help-category /
  provider-catalog / goal-kickoff-prompt data out of the REPL into a
  catalog module in core, so the host and the renderer `catalog-parity` test stop
  reaching into the CLI's REPL.
- **Import-site updates:** Desktop host + the renderer `catalog-parity` test flip
  to the new core catalog path; CLI re-exports the catalog from its REPL shim.
- **Finalize:** remove `@kinqs/brainrouter-cli` from
  `brainrouter-desktop/package.json` and confirm
  `grep -rn "@kinqs/brainrouter-cli/dist" brainrouter-desktop/` returns empty.
- **Checkpoint:** gate (final).

## Consequences

**Benefit**
- One explicit, versioned, acyclic shared package; the Desktop no longer
  reaches into a CLI build artifact. CLI refactors outside the package surface
  can no longer silently break the Desktop.
- The interactive terminal layer stops leaking into the headless engine; the
  agent's prompt dependency becomes an injected port both products satisfy.
- Every batch is independently CI-green and revertible; a future session can
  resume at "batch N" with no shared in-memory context.

**Cost / risk**
- **Build-order fragility.** `dist/` is gitignored, so `core` must build before
  the CLI and the Desktop in both root and Desktop scripts. Batch 0 de-risks this
  on an empty package before any code moves.
- **`exports` map gating.** Adding an `exports` field means deep subpath imports
  only resolve through the `"./*": "./dist/*"` wildcard — omitting it breaks
  every deep import the moment the field exists.
- **Cycle containment.** Moving any exec module beyond the two pure leaves would
  drag the `commandPolicy ⇄ dangerousCommand` cycle into the package. The
  `madge --circular` check after config/exec batches guards this.
- **Shim sprawl (transitional).** Hundreds of CLI re-export shims accumulate.
  They are intentional (they keep ~700 importers and the test suite untouched per
  batch) but should be collapsed in a later cleanup once importers are migrated
  to the package directly.
- **Version lockstep.** `core`, the CLI, and the Desktop must rev together until
  the package is published independently; treat the version as the release line's.

## What explicitly stays CLI-only

- The **interactive terminal layer**: the REPL, readline-backed prompts, the
  TTY prompter implementation, and the CLI command/wizard surface. The agent
  consumes prompting through an injected port, not by importing this layer.
- The **exec cycle and sandbox**: `runtime/exec/sandbox.ts`,
  `runtime/exec/commandPolicy.ts`, `runtime/exec/dangerousCommand.ts`, the
  `runtime/exec/index.ts` barrel, and `runtime/exec/permissionRules.ts` (the
  exec-side rules module, distinct from `config/permissionRules.ts`). The Desktop
  imports none of these; they import `config` one-way across the boundary.
- Anything not on the Desktop's 49-path import surface or required as a leaf to
  compile it — it remains in the CLI and is reached, if ever, through a shim, not
  moved into `core`.

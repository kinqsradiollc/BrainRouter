# 03 — Refactoring & God Files

BrainRouter ran a large god-file breakdown campaign (see the `refactor(...)`
commits). The pattern below is the *canonical* way to decompose a big file. It is
mechanical and reviewable-as-a-pure-move — inventing a different structure
(classes, DI containers) breaks the "no behavior changed" guarantee reviewers
rely on.

---

### 1. Split into a per-concern sibling folder; keep the original path as a thin barrel

When a module grows too large, split it into a per-concern sibling folder (e.g.
`recall.ts` → `recall/config.ts`, `recall/filters.ts`, `recall/pipeline.ts`) and
turn the original file into a thin `export * from './x/y.js'` **barrel** with a
header comment mapping each concern to its new home. **Importers of the old path
must keep working unchanged** — do not update call sites, keep the barrel.

- **Why:** dozens of call sites depend on the original paths, and CI/golden tests
  assume the public surface is stable. This preserves API stability without
  churning every consumer in the same PR as the split.
- **Evidence:** `brainrouter/src/memory/recall.ts`, `brainrouter/src/memory/capture.ts`,
  `packages/types/src/memory.ts:7`, `packages/core/src/util/index.ts:4`

### 2. The closure-heavy variant: `context.ts` + `install*(ctx)` modules + facade

When the large file is a closure web (the Ink chat REPL, the desktop host/
devBridge, App.tsx), use this shape:

1. A **`context.ts`** exporting a shared context interface — immutable inputs as
   `readonly` fields, former closure `let`s as public **mutable** fields, and
   helper functions declared on the interface and **assigned after construction**
   to break import cycles.
2. Per-concern modules each exporting **`installX(ctx: RunChatContext): void`**
   (~30–225 lines) that wire their handlers onto the shared context.
3. The original file becomes a thin **composer/re-export barrel** preserving the
   public surface verbatim.

Locals that are *reassigned* over the process lifetime must be passed through the
live context object (get/set accessors), **never captured by value** — capturing a
reassigned binding silently freezes state the rest of the process later updates.

- **Evidence:** `brainrouter-cli/src/cli/ink/runChat/context.ts`,
  `brainrouter-cli/src/cli/ink/runChat.tsx:23-30`, `brainrouter-desktop/src/devBridge.ts:9`,
  `brainrouter-desktop/electron/host/queries.ts:1`

### 3. In `packages/core`, split modules use `.impl.ts` re-exported from a concern `index.ts`

Core's variant of the split: the heavy implementation lives in a `.impl.ts` file
re-exported from a concern-level `index.ts` barrel (e.g.
`agent/runtime/runTurn.impl.ts` behind `agent/runtime/index.ts`).

- **Evidence:** `packages/core/src/agent/runtime/index.ts`, `packages/core/src/agent/runtime/runTurn.impl.ts`

### 4. Extractions are byte-identical behavior moves — and the header must say so

Move code verbatim; state ownership must not change during a structural refactor.
The file header advertises this ("extracted verbatim", "no behavior change",
"public surface unchanged"). Refactor PR bodies end with an explicit verification
line (e.g. "Behavior-preserving split; public surface unchanged. Verified: 732 cli
tests pass.").

- **Why:** behavioral drift during extraction is the exact failure mode this
  convention guards against; the verification line is how reviewers distinguish a
  mechanical refactor from a behavior change.
- **Evidence:** `brainrouter-desktop/electron/host.ts:17`, `.github/PULL_REQUEST_TEMPLATE.md`

### 5. Giant legacy facades still exist — they are not a license to write new ones

Some files remain large (`runTurn.impl.ts` is ~2200 lines; some desktop lib files
are large). These are acknowledged legacy facades mid-campaign, not precedent.
**Do not grow new god files:** orchestration goes in services, data rules in
domain modules, shell/UI glue in adapters/presentation. Do not do cosmetic folder
moves — a refactor should improve boundaries.

- **Evidence:** `packages/core/src/agent/runtime/runTurn.impl.ts`,
  [`architecture-folder-structure-rules.md`](../brainrouter-docs/architecture-folder-structure-rules.md)

### 6. Cross-workspace effects of a split

Splitting a file that exports an enumerated surface (roles, commands, providers)
can still break golden/parity tests in another workspace even when behavior is
identical, if the export *set* is observed. Run the full root suite after any
split that touches a catalog. See [`07-testing.md`](07-testing.md).

---

## Checklist for a god-file split

- [ ] New per-concern folder created; each module has a purpose header.
- [ ] Original path kept as a thin barrel / composer; public surface **unchanged**.
- [ ] Code moved **verbatim**; header states "no behavior change".
- [ ] Reassigned locals threaded through a live context object, not captured by value.
- [ ] `import type` / inline `import()` used where a value import would cycle.
- [ ] Full root `npm run build` + `npm run test` green (splits can break NodeNext
      emit and cross-workspace golden tests).
- [ ] PR body ends with a verification line naming the passing test count.

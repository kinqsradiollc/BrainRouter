# 02 — Code Style & Conventions

Micro-level style, sampled from real files across every workspace. The overriding
meta-rule: **match the file and package you are editing.** The tree is not
uniformly formatted, and that's intentional.

---

### 1. Prettier is configured but the tree is deliberately NOT mass-formatted

Config: 120-col printWidth, 2-space tabs, single quotes, semicolons,
`trailingComma: "all"`, `arrowParens: "always"`, LF. But **do not run
`prettier --write .` repo-wide** — the pre-commit hook deliberately omits Prettier
because it would reformat the not-yet-formatted tree and churn every commit.
Format only the files you touch, matching their existing style.

- **Why:** large parts of the tree (notably `brainrouter/`) predate the config; a
  mass reformat buries real diffs and churns every open PR.
- **Evidence:** `.prettierrc.json`, `.githooks/pre-commit`, `.githooks/README.md`

### 2. Quote style is per-workspace

`brainrouter/src` (the MCP server) uses **double** quotes (~968 double vs 155
single import lines); `packages/core`, `brainrouter-cli`, and `brainrouter-desktop`
use **single** quotes. Match the file. Use single quotes for new files outside
`brainrouter/src`. Mixing styles *inside one file* is the actual violation.

- **Why:** `brainrouter/` is the oldest package, never reformatted after the
  `singleQuote` config landed.
- **Evidence:** `brainrouter/src/memory/recall/pipeline.ts`, `packages/core/src/util/tokens/usageBreakdown.ts`

### 3. File naming differs by area — check before creating a file

- `brainrouter/src` (MCP server): **kebab-case** (`transport-errors.ts`,
  `memory/util/llm-json.ts`).
- `packages/core/src`: **camelCase** only for non-test source
  (`usageBreakdown.ts`, `permissionRules.ts`) — zero kebab-case source files.
- `brainrouter-cli/src`: camelCase modules + **PascalCase** Ink React components
  (`ChatApp.tsx`, `TuiRouter.tsx`).
- `brainrouter-desktop/src`: PascalCase `.tsx` components (`GoalBanner.tsx`),
  camelCase for `lib/`hooks (`handleQueryResult.ts`).
- Test files under `src/tests/` are predominantly **kebab-case** `*.test.ts` even
  in camelCase packages (`catalog-parity.test.ts`).
- **Evidence:** `brainrouter/src/transport-errors.ts`, `packages/core/src/util/tokens/usageBreakdown.ts`,
  `brainrouter-cli/src/cli/ink/ChatApp.tsx`, `brainrouter-desktop/src/components/chat/GoalBanner.tsx`

### 4. ESM NodeNext: every relative import carries an explicit `.js` extension

All Node workspaces compile with `module`/`moduleResolution` NodeNext, so
relative imports must be written with a `.js` extension even from `.ts`/`.tsx`
sources (`from './recall/config.js'`, `from '../../icons.js'`). The desktop
renderer uses bundler resolution but follows the same convention. Preload
(`electron/preload.cts`) is the exception — it's CommonJS and uses `require()`.

- **Why:** omitting the extension breaks the NodeNext compile and runtime.
- **Evidence:** `brainrouter/src/memory/recall.ts:16`, `brainrouter-desktop/src/components/chat/GoalBanner.tsx:8`

### 5. `interface` for object shapes, string-literal unions instead of `enum`, named exports only

- Use `interface` for object contracts, `type` for unions/aliases/mapped shapes
  (`type GoalStatus = 'active' | 'paused' | …`).
- There are **zero `enum` declarations** in the repo — always use string-literal
  unions.
- There are **zero `export default`s in any `src` tree** (the only two hits are
  ambient `.d.ts` shims for third-party libs). Everything is a named export,
  including React components (`export function GoalBanner(props): React.ReactElement`).
  `React.FC` is never used.
- **Why:** default exports and enums break the re-export-barrel pattern the
  refactor depends on; grep-ability of named symbols is load-bearing.
- **Evidence:** `brainrouter-desktop/src/components/chat/GoalBanner.tsx:10-38`,
  `packages/core/src/config/configTypes.ts:11-63`

### 6. Type-only imports use `import type`; break cycles with inline `import()` types

Write `import type { X } from …` (or inline `import { type WorktreeEntry } from …`).
When importing a type would create a runtime import cycle between sibling modules,
reference it inline in type position instead:
`mcpClient: import('@kinqs/brainrouter-core/mcp').McpClientPool`. There is **no
enforced import ordering** — external and internal imports interleave freely.

- **Why:** NodeNext emits real `require`s for value imports; `import type` and
  inline `import()` keep split-module folders cycle-free at runtime.
- **Evidence:** `brainrouter-cli/src/cli/ink/runChat/context.ts:1-6,26,49`,
  `brainrouter-desktop/src/lib/agent/useAgentEvents/types.ts:7-20`

### 7. Error style: sentence-message `Error`, subclass only to discriminate, bare `catch` for best-effort

- Throw plain `new Error('Sentence-style message with context, ending in a period.')`
  for validation/failures.
- Define `export class XError extends Error` **only** when a caller needs to
  discriminate (`PermissionError`, `InterruptError`, `PathPolicyError`,
  `GoalTooLongError`, `ExternalApiError`).
- Extract messages inline: `err instanceof Error ? err.message : String(err)` (or
  a local `errorText(err)`). There is no global error-wrapping framework.
- Non-critical side operations (status pushes, telemetry, cleanup) swallow
  failures with bare `} catch {}` so they can never break the turn
  (`runTurn.impl.ts` has ~17 deliberate ones).
- **Why:** the agent loop must survive any auxiliary failure; typed-error
  hierarchies everywhere is explicitly not the style.
- **Evidence:** `packages/core/src/track/store/members.ts:29`, `brainrouter-cli/src/cli/ink/runChat/dispatch.ts:44-45`

### 8. Optional fields + `resolve*()` defaults; `null` reserved for deliberate empty slots

Config/domain records declare optional `?` fields with the default documented in
the field comment, and a `resolveX()` fills defaults at read time (raw `CliKnobs`
vs `Resolved*` views). `undefined` is the absence value for data; `null` is for
deliberately-nullable slots (`ReturnType<typeof setInterval> | null`, React state
`| null`). Prefer `??` and optional chaining over truthiness checks on numerics.

- **Why:** persisted config stays forward/backward compatible —
  "omitted ⇒ legacy behavior" is a stated migration invariant.
- **Evidence:** `packages/core/src/config/configTypes.ts:53-79`, `brainrouter-cli/src/cli/ink/runChat/context.ts:38-49`

### 9. `any` is tolerated at untyped boundaries; ESLint is architecture-enforcement only

`strict: true` everywhere, but `any` appears freely at genuinely untyped
boundaries — `catch (err: any)`, `Record<string, any>` for LLM tool args,
`rl: any` for the readline shim. The flat ESLint config intentionally enables
**only** the dist-import boundary ban; `@typescript-eslint` style rules
(`no-explicit-any`, etc.) are registered but NOT enabled ("architecture
enforcement, not a style/rule flood… that ratchets in later"). **Do not** add
sweeping lint rules or `unknown`-ify boundary code as part of an unrelated change.

- **Why:** rule-flood ratcheting is an explicit deferred decision; premature
  strictness churns hundreds of files.
- **Evidence:** `eslint.config.mjs:1-7,37-42`, `brainrouter-cli/src/cli/ink/runChat/turnRunner.ts:74`

---

## Comments & module headers

### 10. Every module and barrel opens with a purpose header (what / why / constraints)

Files begin with a block comment (JSDoc `/** */` or a `//` run) naming the
module's job, why it exists or was split, and any invariant ("The public surface
is unchanged", "Pure types — no runtime behavior", "no import cycle — this module
imports nothing from its siblings"). Even config files (`eslint.config.mjs`,
`.gitignore`, `.githooks/pre-commit`) carry long constraint-explaining comments.
A new module without a purpose header is off-style.

- **Why:** headers are the codebase's institutional memory — agents and reviewers
  rely on them instead of re-deriving intent. In desktop/CLI they *are* the
  primary architecture documentation.
- **Evidence:** `brainrouter/src/memory/recall.ts:1-15`, `packages/core/src/config/configTypes.ts:1-8`,
  `eslint.config.mjs:1-7`

### 11. Comments are dense and explain WHY / tradeoffs, not what — and carry the task/release tag

- Justify design decisions, name the rejected alternative, state observable
  symptoms ("Without this, the row flips through 1 running → 2 running … and the
  user sees flicker"). Mechanism-narration comments ("increment counter") do not
  appear.
- Tag comments implementing a tracked item with its ID + release:
  `// CLI-21 — crash checkpoint: …`, `// MEM-33b — …`, `/** CC-P5.2 — /usage per-actor */`,
  `// 0.4.17 — …`, `// T16 GOLDEN — …` in tests. These IDs are how the codebase is
  navigated across releases and traced back to changelog/plan items.
- **Why:** much of the code encodes non-obvious event-ordering and provider-quirk
  knowledge; the comments are where that survives, and the tags are the audit
  trail linking code to releases.
- **Evidence:** `brainrouter-cli/src/cli/ink/runChat/turnRunner.ts:55-116`,
  `packages/core/src/config/configTypes.ts:22-39`

### 12. Prefer pure functions for anything testable; keep IO at the edges

Cross-system logic (vendor prompt translation, formatting, trust checks, nav
policy) is written as pure exported functions with plain-data in/out, separated
from the IO that invokes them. Presentation builders return `string[]` lines from
a fully-populated input struct ("Pure formatter — the command layer feeds live
numbers"). Best-effort network pushes return `{ ok, error }` and never throw.

- **Why:** the `node:test` suites run against compiled `dist` with no live server/
  DOM/terminal — impure inline logic is untestable by construction.
- **Evidence:** `packages/core/src/util/tokens/usageBreakdown.ts:1-8,54-62`,
  `brainrouter-cli/src/orchestration/delegation.ts:1`

### 13. Bounded concurrency and reentrancy guards for background work

- Bulk async work uses `mapWithConcurrency` (`memory/util/concurrency.ts`) with a
  bounded worker pool — not sequential awaits or unbounded `Promise.all`.
  Embedding concurrency has its own semaphore separate from the generative LLM cap.
- `setInterval`-driven sweepers use an explicit reentrancy guard boolean
  (e.g. `sweepInProgress`) because ticks pile up behind slow LLM calls — copy that
  for any new periodic job.
- Fire-and-forget promises are always `void promise.catch(handler)` (optionally
  `.finally(cleanup)`) — never a floating promise, never awaited on the hot path.
- **Evidence:** `brainrouter/src/memory/util/concurrency.ts`,
  `brainrouter/src/memory/engine.ts:132`, `brainrouter/src/memory/recall/pipeline.ts:174`

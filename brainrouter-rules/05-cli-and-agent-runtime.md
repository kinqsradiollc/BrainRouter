# 05 — CLI & Agent Runtime (`brainrouter-cli/` + core agent loop)

Where the agent turn loop, slash commands, TUI, and config knobs live.

> **Load-bearing fact:** the agent turn loop does **not** live in
> `brainrouter-cli/src`. The turn loop, all turn-end guardrails, and
> `sanitizeToolCallPairing` live in
> `packages/core/src/agent/runtime/runTurn.impl.ts`; the CLI consumes them through
> the Agent's callback surface (`onToolStart`/`onToolEnd`/`onStatusUpdate`/
> streaming deltas). `brainrouter-cli/src/agent/tools/index.ts` is just a
> re-export of `@kinqs/brainrouter-core/tool`. Node >= 22 required.

---

## Slash commands

### 1. Per-domain folder + `tryHandle*` contract — never touch `repl.ts`

Every slash-command family lives in `src/cli/commands/<domain>/` and exports a
single `tryHandle<Domain>Command(ctx: CommandContext): Promise<boolean>` returning
true iff it matched `ctx.command`. `repl.ts` walks the try-handlers in order;
first match wins. To add a command, add a `case '/foo':` to the right category
file's switch — do **not** edit `repl.ts` and do **not** create a new dispatch
mechanism.

- **Why:** the dispatch table was extracted from a god-file REPL precisely so
  command files stay small; wiring into `repl.ts` recreates the god file and
  breaks catalog-parity tests.
- **Evidence:** `brainrouter-cli/src/cli/prompt/repl.ts:9`, `brainrouter-cli/src/cli/commands/memory/index.ts:26`

### 2. Big command families: `index.ts` is a thin dispatcher; shared bits in `_`-prefixed files

When a family outgrows one file, split into sibling modules
(`orchestration/{workers,agents,spawn,federation,policy,background}.ts`) and keep
`index.ts` a pure switch/re-export preserving the original public surface.
Cross-command helpers used by 3+ categories live in underscore-prefixed files
(`_context.ts`, `_helpers.ts`, `_shared.ts`); single-category helpers stay in that
category's file.

- **Evidence:** `brainrouter-cli/src/cli/commands/orchestration/index.ts:1`, `brainrouter-cli/src/cli/commands/_helpers.ts:1`

### 3. New slash commands must be registered in BOTH `SLASH_COMMANDS` and `HELP_CATEGORIES`

`validateCatalogParity` asserts the tab-completion list and the `/help` rows name
exactly the same commands, and the desktop re-checks the CLI's catalog. Add a
command to both heads at once. The catalog moved to
`@kinqs/brainrouter-core/command` (ADR-003). See [`07-testing.md`](07-testing.md)
for the golden tests you must update.

- **Evidence:** `packages/core/src/command/parity.ts`, `brainrouter-cli/src/tests/catalog-parity.test.ts:14`

### 4. Command handlers delegate — they don't orchestrate

Slash handlers never spawn processes or run multi-step logic themselves.
Background work goes through `agent.spawnBackgroundWorker` (separate Agent +
on-disk transcript); multi-phase flows (e.g. `/build`) are launched by handing
`ctx.repl.runAgentTurn` a prompt instructing the agent to call the orchestration
tool (`run_workflow` with template + templateArgs). Use `runAgentTurnAsync` when
the handler needs post-turn cleanup (e.g. `/side` restoring the parent
`sessionKey` via `.finally`).

- **Why:** foreground turn-state is a shared hazard; reusing the worker infra +
  the agent's own tools keeps transcripts, guardrails, and policy on every path.
- **Evidence:** `brainrouter-cli/src/cli/commands/orchestration/spawn.ts:12,44`

### 5. MCP-backed commands print through shared helpers; classic output is chalk + newline-padded

Commands calling brain tools go through `printMcpCall`/`printMemoryCards`
(`commands/_helpers.ts`) — don't hand-roll `callMcpTool` + `console.log`. Non-Ink
output uses `console.log` with chalk: leading + trailing `\n` padding,
`chalk.red` for usage errors (still `return true` — the command WAS handled),
`chalk.gray` for hints, `chalk.cyan` for identifiers.

- **Why:** returning `false` on a usage error wrongly falls through to "unknown
  command".
- **Evidence:** `brainrouter-cli/src/cli/commands/_helpers.ts:24`

---

## Config & environment

### 6. ⛔ Every CLI knob lives under `cli.*` in `config.json`, read via `getCliKnobs()`

Runtime tunables are fields of the `cli` block in
`~/.config/brainrouter/config.json`, accessed through `getCliKnobs()` (cached,
lazy). Flags that override a knob use `setCliKnobOverride()` (this replaced
mutating `process.env.BRAINROUTER_*`); tests reset with `_resetCliKnobsCache()`.
Use `getRawCliKnobs()` only to distinguish "user set it" from "default-resolved".
**Do not introduce new `BRAINROUTER_*` env vars** — the few that remain are legacy
terminal escape hatches (`ALT_SCREEN`/`SHOW_CURSOR`) or server-side auth.

- **Evidence:** `packages/core/src/config/config.ts:655,685`

### 7. ⛔ The CLI never loads `.env`

Do not add dotenv loading (or any `.env` read) to the CLI. Source of truth for LLM
creds, MCP profiles, and theme is `~/.config/brainrouter/config.json` set via
`wizard`/`login`/`config`; real shell env still flows through for fallbacks like
`OPENAI_API_KEY`. The MCP server loads its own `server.env` in its own cwd — that's
the server's business. The only dotenv references in CLI code exist to *filter* its
deprecation banner from stderr.

- **Why:** a `.env` auto-load would silently shadow the config wizard and leak
  workspace-local secrets into every session.
- **Evidence:** `brainrouter-cli/src/entry/shared.ts:7`, `brainrouter-cli/src/entry/bootstrap.ts:10`

### 8. Entrypoint: thin commander program, one `register*Command` per subcommand, bootstrap first

`src/index.ts` stays minimal: `import './entry/bootstrap.js'` **first** (its
top-level side effects install warning filters + crash diagnostics before any
command registers), then call `register<X>Command(program)` from `src/entry/*.ts`.
New top-level subcommands get their own `entry/xCommand.ts` registrar; no command
logic in `index.ts`.

- **Why:** bootstrap ordering is load-bearing — handlers must exist before parsing.
- **Evidence:** `brainrouter-cli/src/index.ts:1`

---

## Agent runtime invariants (in core)

### 9. Model-adherence problems are fixed with bounded turn-end guardrails, not prompting

When a model skips agentic bookkeeping (stalls on preambles, never reconciles the
plan, promises tools then asks a question), add a **bounded, counter-guarded**
nudge in `runTurn.impl.ts` alongside `preambleGuard` (max 2),
`planSyncGuard`/`fanOutGuard`/`deliverableGuard` (max 1), etc. Guards must have a
hard `*_MAX` so a non-compliant model can never loop, and the plan-sync signal is
the completed-count delta (not "called update_plan"). Do **not** fix these by
growing the system prompt or adding CLI-side retries.

- **Why:** prompt-only fixes don't stick on weaker models; unbounded guards create
  infinite loops.
- **Evidence:** `packages/core/src/agent/runtime/runTurn.impl.ts:514,543`

### 10. ⛔ Tool-call pairing is sacred: sanitize at the transport boundary

Every LLM request is built from `sanitizeToolCallPairing(this.chatHistory)` — a
non-mutating, idempotent copy that synthesizes results for orphaned
`assistant.tool_calls` and drops leading orphan tool results — so strict gateways
never see a malformed sequence (they reject with "tool call result does not follow
tool call (2013)"). **Never send `chatHistory` raw.** On the CLI render side, pair
`onToolStart`/`onToolEnd` rows with `toolPairKey` (LLM tool_call id first, tool
name as fallback) so parallel same-name calls don't collide.

- **Why:** resume, compaction, interrupts, and guard injects can all malform
  history; the sanitize pass at the send site is the single guarantee.
- **Evidence:** `packages/core/src/agent/runtime/runTurn.impl.ts:733`,
  `brainrouter-cli/src/runtime/observability/toolPairing.ts`

### 11. ⛔ A `role:'user'` transcript entry WITH a `name` is a system/guard injection — never render it as the user

Guard nudges are recorded as `{ role: 'user', name: 'guard', … }` so the model
receives them as a turn, but every render/export/recap/rewind path must classify
named user entries as system, excluding them from "User" headings, prompt counts,
and rewind points. Any new code iterating user entries applies this filter
(`guard-message-hidden.test.ts` covers each path).

- **Why:** rendering a guard as if the user typed it corrupts exported transcripts,
  recaps, and rewind timelines.
- **Evidence:** `brainrouter-cli/src/tests/guard-message-hidden.test.ts:8`,
  `brainrouter-cli/src/orchestration/agentTranscriptView.ts`

---

## TUI (Ink) conventions

### 12. Keyboard model: overlay short-circuit first, Esc-toggled scroll mode, composer defocus for letter-key modes

The single chat-level `useInput` handler (`useChatInput`) must return immediately
when an overlay is mounted so the overlay owns every keystroke (else Ctrl+C/
Shift+Tab double-fire — the "/config exits to bash" class of bug). Esc enters
scroll mode only when no slash palette/@-completion/flag popup owns the key; in
scroll mode the composer is defocused so plain keys (`w`/`k`/`s`/`j`, `g`/`G`,
PageUp/Dn) scroll instead of typing; Esc/i/Enter/q exit. Ctrl+C/Ctrl+D always
exit. **Do not remove the full-height Sidebar** or let composer keys double as
scroll keys.

- **Why:** Ink runs all mounted `useInput` handlers; without the precedence chain
  keys double-handle, and macOS Terminal swallows PageUp so letter-key scrolling is
  the accepted pattern.
- **Evidence:** `brainrouter-cli/src/cli/ink/ChatApp/useChatInput.ts:60,103`,
  `brainrouter-cli/src/cli/ink/components/Sidebar.tsx`

### 13. Streaming render discipline: ref-buffer deltas, one shared ~80ms flush timer, never setState per token

Token deltas (assistant AND reasoning) accumulate into ref buffers and flush
through a SINGLE shared `setTimeout` (~80ms ≈ 12Hz). Do not add a second timer or
call setState per delta. Reasoning renders a trailing window, not the full chain.
`ScrollbackRow` is memoized. Changes here need the `ink-streaming` tests (mount
ChatApp, assert coalescing against real timers) to stay green.

- **Why:** two independent 33ms timers previously doubled re-render rate and caused
  flicker; per-token setState pins the reconciler.
- **Evidence:** `brainrouter-cli/src/cli/ink/ChatApp/useScrollbackState.ts:57`,
  `brainrouter-cli/src/tests/ink-streaming.test.tsx:44`

### 14. `runChat` lifecycle: `install*(ctx)` over one shared mutable `RunChatContext`; extractions are verbatim

The Ink chat REPL's turn lifecycle is spread across `runChat/*` modules, each an
`install<Thing>(ctx: RunChatContext)` wiring onto a single shared mutable context;
helpers are assigned onto `ctx` after construction so cyclic references resolve
without import cycles. When splitting more of ChatApp/runChat, move code
byte-for-byte and say so in the header; state ownership must not change during a
structural refactor. (See [`03-refactoring-and-god-files.md`](03-refactoring-and-god-files.md).)

- **Evidence:** `brainrouter-cli/src/cli/ink/runChat/context.ts:9`, `brainrouter-cli/src/cli/ink/runChat.tsx:33`

---

## Skills in the CLI

### 15. Skill discovery: re-scan disk every read, first-name-wins, `safeMode` loads nothing

Skill roots are ordered workspace (`skills/`, `.brainrouter/skills`) → local →
plugin → bundled, and re-scanned from disk on every catalog read (no in-memory
cache to bust). First entry per name **wins**, but collisions must be recorded
(`collides`/`shadowedBy`/`qualifiedName` `<scope>:<name>`), not silently dropped.
`knobs.safeMode` returns an empty skill list; `knobs.skillsHideBundled` excludes
the bundled root. Keep the CLI slash prompt thin — author heavy workflow content in
the skill body (the single source of truth). See [`09`](09-docs-skills-and-plugins.md).

- **Evidence:** `brainrouter-cli/src/cli/prompt/skillCatalog.ts:31,33,96`

### 16. Workspace tool profiles filter each Agent turn; never mutate the extension registry

Manifest `tools.profiles` and task-time capability profiles resolve through the
single mapping in `workspace/toolProfiles.ts`. Apply that selection to the
model-visible local surface and re-check it at dispatch. Profile assignments are
explicit: unassigned control-plane/security tools and unknown extension tools
retain their existing behavior, while a missing manifest is an exact no-op.
Manifest tool/extension denies subtract after profile selection and user
force-on overrides cannot bypass the gate. Never reload, unregister, or mutate
process-global extensions to represent one workspace or one task.

- **Evidence:** `packages/core/src/workspace/toolProfiles.ts`, `packages/core/src/tests/workspace-tool-profiles.test.ts`, `packages/core/src/agent/runtime/runTurn.impl.ts`

### 17. Workspace profile briefings replace by tag at the per-turn capability chokepoint

For a readable manifest, resolve the active persona and task capabilities first,
then publish one bounded profile briefing through
`refreshWorkspaceCapabilityState`. Only runtime-known capability ids are
rendered. Frontend and backend remain task-scoped capabilities of the single
`engineer` persona; their skill and tool-profile contributions intersect live
catalog and tool policy and never grant authority by themselves. Reuse the
tagged system-message slot so workspace switches replace profile/persona state
instead of accumulating it; a missing manifest retracts the tag and preserves
the pre-onboarding prompt exactly.

- **Evidence:** `packages/core/src/agent/workspaceCapabilityState.ts`, `packages/core/src/tests/workspace-capability-state.test.ts`

---

## Comments & tests

- Comments carry task IDs + release versions and explain WHY (`CLI-21`,
  `FED-S5 (0.4.2)`, `REFAC-CHATAPP-SPLIT (0.4.17)`). File headers are prose
  paragraphs on what the module owns and why it was split.
- Tests are `node:test` + `assert/strict` in `src/tests/*.test.ts(x)`, compiled
  then run from `dist` (`npm test` builds first). Ink components tested with
  `ink-testing-library`'s `render()` + `lastFrame()`. Details in [`07`](07-testing.md).

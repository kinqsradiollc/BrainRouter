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

### 11a. Every model request crosses the typed context-envelope boundary before pairing repair

Build root request context with `buildRootContextEnvelope`, then materialize its
wire messages and apply `sanitizeToolCallPairing`; never bypass either boundary.
Each layer declares a replacement key, provenance, priority, token/character
budget, compaction policy, child-inheritance posture, and trust/secret flags.
Required policy, active persona/capability/orchestration, workspace guidance,
and selected skill instructions are protected from summarization. The envelope
is request-scoped and in-memory; never turn it into another durable memory or
knowledge store.

- **Evidence:** `packages/core/src/context/contextEnvelope.ts`,
  `packages/core/src/agent/runtime/runTurn.impl.ts`,
  `packages/core/src/tests/context-envelope.test.ts`

### 11b. Context compaction is staged, progress-bounded, and fail-closed

Compaction may replace older conversation, tool, plan, memory-briefing, and
source layers only with a provenance-labelled summary. Exclude protected policy,
persona, capability, orchestration, workspace-guidance, and skill layers from
the summarizer; include any prior summary so repeated compaction remains
resumable. Preserve the latest user turn and unresolved constraints, citations,
failures, authorization boundaries, and checks not run. Every stage records
before/after size, makes measurable progress within the envelope's hard
iteration ceiling, and returns the original envelope unchanged when protected
context cannot fit. Summary prompts never copy secret values.

- **Evidence:** `packages/core/src/context/envelope/compaction.ts`,
  `packages/core/src/agent/runtime/session.impl.ts`,
  `packages/core/src/prompt/compaction/compactor.ts`,
  `packages/core/src/tests/context-compaction.test.ts`

### 11c. Delegated children receive a bounded task packet, never the parent transcript

Every child starts from a versioned `DelegatedTaskPacket`: bounded task and
output contract, selected persona/orchestration role, capabilities recomputed
from the child task, inherited constraints and plan/memory/source references,
the parent's effective tool-policy ceiling, and explicit execution budgets.
Only envelope layers marked inheritable may be referenced; recent conversation,
tool state, and the parent's active capability overlay never cross the boundary.
The child rebuilds its own system prompt and task capabilities, and every tool
path—including MCP discovery—must remain inside the parent's ceiling. Wait
results expose conclusions, evidence, changes, verification, unresolved items,
and failures as a structured projection.

- **Evidence:** `packages/core/src/orchestration/delegation/taskPacket.ts`,
  `packages/core/src/orchestration/tools/spawn.ts`,
  `packages/core/src/orchestration/tools/summarize.ts`,
  `packages/core/src/tests/delegated-task-packet.test.ts`

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

### 16. Workspace tool selection filters each Agent turn; never mutate the extension registry

Manifest `tools.profiles` and task-time capability profiles resolve through the
single mapping in `workspace/toolProfiles.ts`. Apply that selection to the
model-visible local surface and re-check it at dispatch. Profile assignments are
explicit. For manifest v2 (`legacy-groups`), unassigned control-plane/security
tools and unknown extension tools retain their existing behavior. Manifest v3
(`explicit-catalog`) instead exposes only expanded reviewed groups plus reviewed
stable tool IDs; unselected and unknown local tools fail closed. A missing
manifest remains an exact no-op. Denies subtract last, and user force-on
overrides cannot bypass the gate.

Build review choices from `workspace/selectionCatalog.ts`, never an app-owned
ID list. V3 is created only by a reviewed migration against a fresh catalog
fingerprint; loading v2 must not infer or persist v3 semantics. Live
MCP/server-advertised names are informational and non-persistable. A v3
workspace opens the dynamic MCP surface only through a reviewed stable MCP
control entry, while the normal access, capability, scope, approval, and
dispatch checks still apply. Never reload, unregister, or mutate process-global
extensions to represent one workspace or one task.

- **Evidence:** `packages/core/src/workspace/toolProfiles.ts`, `packages/core/src/workspace/selectionCatalog.ts`, `packages/core/src/tests/workspace-tool-profiles.test.ts`, `packages/core/src/tests/workspace-selection-catalog.test.ts`, `packages/core/src/agent/runtime/runTurn.impl.ts`

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

### 18. Native-terminal tools attach to host-owned sessions; they never spawn shells

The Desktop host may give the top-level local Agent a terminal-use port for PTYs
the user already opened. Keep list/read output bounded and strip control
sequences before returning it to the model. Terminal input is bounded and
approval-gated. Never accept a shell executable, working directory, environment,
or spawn arguments through this port; new processes remain the responsibility of
the normal Terminal UI or `run_command`. Do not copy the port into silent
children, reviewers, workers, remote-brain sessions, or non-shell workspace
profiles.

- **Evidence:** `brainrouter-desktop/electron/host/pty.ts`, `packages/core/src/extension/builtin/runtime.ts`, `packages/core/src/agent/runtime/runTurn.impl.ts`

### 19. Queue and Steer share one core contract; Steer enters only at safe model boundaries

Queue is FIFO input that starts after the active turn settles. Steer is input for
the active turn and may enter chat history only between complete model/tool
batches—never between an assistant tool call and its matching result. CLI and
desktop use the shared core input primitives and agent-protocol delivery events,
including queued, applied, completed, and canceled states. Background extensions
deliver through the same Steer inbox with `source:'extension'`; they do not
invent a second conversation or session channel.

- **Why:** host-local implementations drift, and injecting an asynchronous event
  inside a tool batch corrupts strict provider history.
- **Evidence:** `packages/core/src/session/input/inputDelivery.ts`,
  `packages/core/src/agent/runtime/runTurn.impl.ts`,
  `packages/agent-protocol/src/index.ts`

### 20. Provider-specific background observation is an extension; session delivery is core

Keep pull-request provider commands, status normalization, polling intervals,
and transition detection in an optional built-in extension. The extension may
publish only through the privileged session-input port; user and workspace
extensions cannot request that port. Core owns the bounded session-keyed inbox
and safe-boundary Steer contract, while CLI and Desktop own how an idle session
resumes and how delivery state is rendered.

Background polling must return control immediately, use non-overlapping bounded
reads, expire, retain bounded watcher state, and never accept a command, working
directory, repository, token, or environment from model input. Failures report
back into the originating session so the same agent can diagnose and repair
them during normal conversation or a goal run.

Automatic extension steering carries normalized transition metadata only. Never
inject pull-request titles, comment/review bodies, check names, logs, or command
errors into a turn. Mark extension steering as a background observation and
require the agent to retrieve external content explicitly as untrusted data.

- **Evidence:** `packages/core/extensions/pull-request-observer/index.js`,
  `packages/core/src/session/input/inputDelivery.ts`,
  `packages/core/src/extension/host.ts`

---

## Comments & tests

- Comments carry task IDs + release versions and explain WHY (`CLI-21`,
  `FED-S5 (0.4.2)`, `REFAC-CHATAPP-SPLIT (0.4.17)`). File headers are prose
  paragraphs on what the module owns and why it was split.
- Tests are `node:test` + `assert/strict` in `src/tests/*.test.ts(x)`, compiled
  then run from `dist` (`npm test` builds first). Ink components tested with
  `ink-testing-library`'s `render()` + `lastFrame()`. Details in [`07`](07-testing.md).

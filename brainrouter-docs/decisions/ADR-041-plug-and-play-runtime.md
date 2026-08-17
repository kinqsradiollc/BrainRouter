# ADR-041 — Plug-and-play runtime: swappable providers, capability ports, and product-wide registries

**Status:** PROPOSED

**Builds on:** ADR-029 (one workspace, many surfaces), the existing `ExtensionHost` and
`ProviderDefinition` system.

**Supersedes (on acceptance):** the remaining unimplemented scope of ADR-006 (further service
splits) and ADR-008 (the blanket "every module a port" program) — both continue here as
seams-where-they-matter plus D12 service profiles.

**Date:** 2026-08-15

---

## 0. The decision in one page

BrainRouter has an extension system, a provider definition, and a concrete agent. What it does not
have is the ability to swap any of them at runtime without editing core.

Providers are frozen at module load. The tool runtime is a 1,600-line switch with filesystem and
shell logic inline. The agent loop has no interception points. Every host surface — MCP server, CLI,
desktop, API — dispatches through hard-coded switch statements or static arrays. The memory engine
casts one god-store to twelve narrow interfaces with `as unknown as`. Native providers cannot
stream — they fall back to non-streaming calls inside a function named `callOpenAIStream`.

This decision makes those seams swappable without replacing the systems that already work:

> **Evolve the existing `ExtensionHost` into the single registration surface. Providers, capability
> ports, phase hooks, and product-wide dispatch tables all become runtime-swappable through typed
> registration APIs on the host. The concrete `Agent` class gets an `IAgent` interface so hosts
> depend on the abstraction. No existing extension or provider breaks.**

The end state goes one step past "registries exist": **every part of the runtime is a registration —
including each builtin tool and the agent loop's default driver — every registration is a reversible
effect that can be scoped to one session, interception is waterfall middleware rather than
observe-only hooks, and the tree a given surface boots is composed from layered configuration that
can be dumped and patched without touching core.** D1–D7 build the registries; D8–D11 make them a
plugin system.

Twelve decisions, a feature-parity program (D13), and its transparency capstone (D14 — the human
can watch, inspect, and replay the whole process). Each implementation slice is one pull request;
D13/D14's waves are tracked as their own slice series.

---

## 1. Where the code is today

| Seam | Current shape | Why it is not swappable |
|---|---|---|
| Provider registry | `PROVIDER_REGISTRY: ReadonlyMap` in `packages/core/src/provider/providers/index.ts` — built from `BUILTIN_PROVIDERS` at module load | `ReadonlyMap` has no mutation API. `ExtensionHost.registerProvider` adds to a separate extension store, not the builtin registry. Consumers (`provider/catalog.ts`, `provider/routing/registry.ts`, `agent/agent.ts`, `review/critic.ts`) read the frozen map. |
| Tool runtime | `invokeBuiltinToolRuntime` in `packages/core/src/extension/builtin/runtime.ts` — one ~1,600-line `switch (name)` | Filesystem I/O is inline (`fs.readFileSync` @444, `fs.writeFileSync` @497). The `run_command` case carries ~200 lines of inline approval, policy, and sandbox-resolution logic (@624–822). No capability interface separates "what the tool does" from "how the side effect executes." |
| Agent loop | `Agent` class in `packages/core/src/agent/agent.ts` — 2,347-line file, class starts @719 | No `IAgent` interface. Hosts import `Agent` directly. The turn loop (`runTurn` / `runTurnImpl`) has no interception points — an extension cannot observe or modify a phase. |
| Extension host | `ExtensionHost` interface in `packages/core/src/extension/host.ts` | Has typed registrars (`registerTool`, `registerProvider`, `registerHook`, `registerPanel`) but no `registerPhaseHook` and no `registerDisposable`. Provider registration writes to a parallel store, not the live registry. |
| Streaming | `callOpenAIStream` in `packages/core/src/agent/transport/llmTransport.ts` (@1176) | OpenAI-shaped SSE parsing. Native providers (`anthropic-messages`, `gemini-generate`) fall back to non-streaming `callNativeProvider` (@1214) and surface the full text as one delta. The streaming interface is callbacks (`onTextDelta`, `onReasoningDelta`), not a typed chunk union. |
| MCP tool dispatch | `switch (request.params.name)` in `brainrouter/src/transport/mcpServer.ts` (@488) — 98 case labels | Adding a tool means editing the switch. No registry. |
| CLI command dispatch | 24 sequential `if (await tryHandle*Command(cmdCtx)) return;` calls in `brainrouter-cli/src/cli/prompt/repl.ts` (@137–160) | Adding a command means importing a new handler and inserting it in the chain. No registry. |
| Desktop panels | Static `PANEL_DEFS` array in `brainrouter-desktop/src/panels/panelCatalog.ts` | Adding a panel means editing the array and the `PanelId` union. No runtime registration. Extensions cannot contribute panels. |
| API routes | ~48 inline `app.use("/api/...", router)` calls in `brainrouter/src/index.ts` (@356–412) | Adding a route means editing the server entry point. No route table. |
| Memory store access | `this.store as unknown as TenancyStore` (and 11 more) in `brainrouter/src/memory/engine.ts` (@438–524) | One god-store object cast to 12 narrow interfaces across 73 sites. No composite interface declares what the store actually provides. |

### 1.1 What already works

The extension system is real and shipped. `ExtensionHost` has typed registrars. Extensions activate
through a loader (`packages/core/src/extension/loader.ts`) that calls
`mod.activate(createExtensionHost(...))`. The `ProviderDefinition` interface
(`packages/core/src/provider/providers/definition.ts`) is a plain object describing endpoint
identity and wire behaviour — it is not the problem. The problem is that the registration surface
stops short of the runtime seams above.

---

## 2. Decisions

### D1 — Live provider registry with disposable handles

Replace `PROVIDER_REGISTRY: ReadonlyMap` with a `ProviderRegistry` class that supports runtime
mutation:

- `register(def: ProviderDefinition): DisposableHandle` — adds a provider, returns
  `{ dispose(), replace(next) }`. Conflict on same `id` throws.
- `dispose()` removes the provider and fires a `providers-updated` notification.
- `replace(next: ProviderDefinition)` atomically swaps a provider definition. Active turns using the
  old definition finish; new turns see the replacement.
- `BUILTIN_PROVIDERS` are registered at startup through the same API — no special-case path for
  builtins.
- All existing consumers (`provider/catalog.ts`, `provider/routing/registry.ts`, `agent/agent.ts`,
  `review/critic.ts`) read through `ProviderRegistry.entries()` — same read API, now live.

The `ExtensionHost.registerProvider` method is rewired to call `ProviderRegistry.register()` instead
of writing to the parallel extension store. One registry, one source of truth.

### D2 — Provider-neutral streaming protocol

Introduce a `StreamChunk` discriminated union that replaces the callback-based streaming interface
in core:

- The union covers: text deltas, reasoning deltas, tool-call deltas, tool-result deltas, finish, and
  error.
- `callOpenAIStream` becomes `callProviderStream` — it returns an `AsyncIterable<StreamChunk>` that
  the agent loop consumes. The OpenAI SSE parser translates native events into `StreamChunk` entries
  at the provider boundary.
- Native providers (`anthropic-messages`, `gemini-generate`) gain a streaming path — they translate
  their own SSE events into `StreamChunk` entries instead of falling back to non-streaming
  `callNativeProvider` and surfacing the full text as one delta.
- Downstream consumers (CLI streaming display, desktop streaming, tool result assembly) consume
  `StreamChunk` only — no provider-specific types leak into core.

### D3 — Capability ports for the tool runtime

Extract three capability interfaces from the `invokeBuiltinToolRuntime` monolith:

- `FilesystemPort` — `readFile`, `writeFile`, `readDir`, `stat`, `notebookEdit`. Today these are
  inline `fs.*` calls at `runtime.ts:444`, `:497`, `:518`, `:536`, `:561`.
- `ShellPort` — `runShell`, `startBackgroundShell`. Today the bare exec is delegated to `runShell()`
  (imported at `runtime.ts:35`, called at `:811`) but ~200 lines of approval, policy,
  sandbox-resolution, and destructive-command-guard logic sit inline in the `run_command` case
  (`:624`–`:822`).
- `SubprocessPort` — `spawnWorkerThread`. Today called inline at `runtime.ts:1161`.

The `switch (name)` stays as the tool dispatcher, but each case delegates the side effect to an
injected port. Default port implementations wrap the current `fs` / `runShell` /
`spawnWorkerThread` calls — no behaviour change. The ports are registered on `ExtensionHost` and
swappable at runtime.

### D4 — Agent phase hooks and IAgent interface

Two changes that together make the agent loop pluggable:

**IAgent interface.** Extract from the concrete `Agent` class (`agent.ts:719`, 2,347-line file). Hosts
(CLI, desktop, MCP server) depend on `IAgent`, not `Agent`. The `Agent` class implements `IAgent`; no
behaviour changes. The existing `IAgentRuntime` port at `runtimeTypes.ts:91` is a separate
runtime-plane seam and is not affected.

**Phase hooks.** Add `beforePhase` / `afterPhase` interception to the agent turn loop. Named phases
are drawn from the existing loop structure: `turn-start`, `provider-call`,
`tool-execution`, `turn-end`. An extension registers a handler via
`ExtensionHost.registerPhaseHook(phaseName, handler)`. Handlers receive the phase context (turn
state, messages, tools) and may observe or modify it. Hooks fire synchronously before/after the
phase; `afterPhase` handlers may short-circuit the remaining turn.

**Waterfall semantics.** Interception points on the *hot path* — `pre-step` (what the model will
see), `provider-call`, and tool `pre-execute` / `post-execute` — are **waterfalls, not broadcasts**:
handlers form an ordered chain and each receives a `next()` continuation. A handler may pass
through, rewrite the payload before delegating, or refuse to call `next()` and thereby reject the
step / call outright (a rejected first claim still closes a durable zero-step turn so the transcript
records the attempt). `turn-end`-class notifications stay serial with no `next()`. This is what
separates "an extension can watch the loop" from "an extension can *be part of* the loop."

**Event domains and the logged invariant.** Extension-visible events split into three explicit
domains so authors pick the right one: **durable transcript events** (facts that must survive a
reload — appended via the existing transcript store and broadcast after append), **live agent
events** (the waterfalls and notifications above — never persisted), and **capability events**
(policy/adapters attaching to a port seam without importing the loop). One invariant binds them:
**anything that reaches a model request must be reconstructable from the transcript.** A hook that
injects model-visible context does it by appending a typed transcript entry, never by mutating an
in-flight message array that the log will not reflect — and a runtime assertion enforces this in
dev builds. This keeps fork/resume/replay and the existing tool-call-pairing sanitizer truthful
under arbitrary third-party hooks.

### D5 — Product-wide registry pattern

Replace four hard-coded dispatch structures with typed registries. Same pattern, four surfaces:

**McpToolRegistry** — replaces the 98-case `switch (request.params.name)` in `mcpServer.ts:488`.
Each tool registers `{ name, handler, schema }`. The MCP handler iterates the registry instead of
switching.

**CommandRegistry** — replaces the 24 sequential `tryHandle*Command` calls in `repl.ts:137–160`.
Each command category registers `{ prefix, handler }`. The REPL walks the registry in registration
order.

**PanelRegistry** — replaces the static `PANEL_DEFS` array in `panelCatalog.ts`. Panels register
`{ id, title, icon, group, component }`. The `PanelId` union is generated from registered entries.
Extensions can contribute panels through `ExtensionHost.registerPanel` — which already exists but
writes to a separate store.

**ApiRouteRegistry** — replaces the ~48 inline `app.use` calls in `index.ts:356–412`. Each route
module registers `{ path, router, middleware }`. The server entry point iterates the registry. The
dashboard is Next.js (file-based routing) and is not affected.

### D6 — IMemoryStoreComposite

Formalise a composite interface that declares what the memory store actually provides:

- `IMemoryStoreComposite` extends the 12 capability store interfaces: `TenancyStore`,
  `EmailAuthStore`, `OrgPersonaStore`, `MemorySharingStore`, `ProjectStore`,
  `KnowledgeDocumentStore`, `AdminConsoleStore`, `ProviderStore`, `ModelPolicyStore`,
  `RemoteAccessStore`, `IntegrationStore`, `ConnectorStore`.
- `MemoryEngine` implements `IMemoryStoreComposite`. Domain backends (`MeetingsStore`, `TeamsStore`,
  `NotesStore`, `PlannerStore`, `ChatThreadStore`, `TrackStore`, etc.) consume the composed
  interface — they request the capability they need through the interface, not through
  `store as unknown as *Store`.
- The 73 `as unknown as` casts (12 in `engine.ts:438–524`, the rest in domain `backend.ts` files)
  are removed. The type system enforces what the store provides.

### D7 — Extension host evolution

The architectural statement that we **evolve** the existing `ExtensionHost`, not replace it:

- `registerPhaseHook(phaseName, handler)` — new method (from D4).
- `registerDisposable(handle)` — new generalised method so extensions can tear down their own
  registrations on unload.
- Provider registration is unified — `registerProvider` calls `ProviderRegistry.register()` (from
  D1), eliminating the parallel extension store.
- The existing `registerTool`, `registerHook`, `registerPanel` typed registrars are unchanged.
  `BuiltinExtensionHost.registerCoreCapability` is unchanged.
- The activation contract (`ExtensionActivate = (host: ExtensionHost) => void | Promise<void>`) is
  unchanged. Extensions that use the existing API keep working without modification.

### D8 — Builtin tools become registrations; the switch dissolves into a guarded pipeline

D3 injects ports under the switch; D8 removes the switch. Every builtin tool registers on the same
tool registry extensions use: `{ name, schema, handler, capabilities }`. Dispatch is a registry
lookup, and the ~200 lines of approval, policy, sandbox-resolution, and destructive-guard logic
currently inlined in the `run_command` case (`runtime.ts:624–822`) are lifted into a **shared
guarded execution pipeline** that fronts *every* tool call: `pre-execute` waterfall (D4) → approval
gate → policy/guard evaluation → port-backed side effect → `post-execute` waterfall. Guards stop
being one tool's private code and become pipeline stages a third-party tool gets for free — and
cannot skip. The tool schema joins prompt assembly from the registry, so registering a tool is the
complete gesture: no switch edit, no prompt edit, no MCP-surface edit (D5's `McpToolRegistry`
becomes a projection of this registry rather than a second list).

### D9 — Every registration is a reversible effect; registrations can be scoped to one session

Two rules, applied uniformly:

- **Reversibility.** *Every* registrar on `ExtensionHost` — tools, providers, ports, phase hooks,
  panels, commands, routes — returns a disposable handle, and unloading an extension disposes
  everything it registered, in reverse order. `registerDisposable` (D7) is the escape hatch for
  effects the host does not model; it is not the mechanism. Hot-swap of an extension is then
  unload + load, with no restart and no leaked handlers.
- **Scoping.** The host gains **scoped contexts**: `host.scope(sessionKey)` returns the same typed
  registration surface, but everything registered through it exists only for that session's agent
  and unwinds when the session ends. This is how one session gets a different capability set — a
  reviewer session with read-only ports, a fleet child with a narrowed tool list, a pentest session
  with an extra tool — expressed as **capability presets**: named bundles of scoped registrations
  applied at session start. Roles (`orchestration/roles`) become consumers of presets instead of
  ad-hoc allowlists.

### D10 — Execution worlds: filesystem, shell, and subprocess swap as one unit

D3's three ports are not independently swappable in practice — a shell that runs remotely while the
filesystem port reads locally is incoherent (the command's output files are not where `read_file`
looks). Introduce an **`ExecutionWorld`**: a named binding of `FilesystemPort + ShellPort +
SubprocessPort` (plus the sandbox resolver) that is selected *as a set*. `local` is the default
world wrapping today's implementations; the existing runtime backends (`runtime/backends/worktree`,
`runtime/backends/container`) become alternative worlds instead of bespoke code paths. Swapping the
world moves **everything that executes** — run_command, background shells, workers, sandbox
resolution — in one gesture, which is the actual plug-and-play property: point the world at a
container or a remote box and every tool follows, with no per-tool forks. ADR-042's
worktree-attached roots slot in as a world parameter, not a fourth port.

### D11 — Composition from configuration: profiles, layers, and a dumpable tree

What boots is currently decided by code in each host surface. Make it data:

- A **profile** is a named composition stored under the BrainRouter home (and overridable per
  workspace via `.brainrouter/`): the ordered list of extension bundles to mount, the execution
  world, the capability presets available, and configuration rows for each mounted extension.
  `desktop`, `cli`, `mcp`, and `fleet` ship as the built-in profiles — the four hosts stop being
  four hand-wired compositions and become four profile files interpreted by one loader.
- **Layering.** A boot applies layers in order to an empty tree: built-in profile → workspace
  overlay → user overlay → command-line overlay. A layer targets a row by id and replaces its
  config or inserts new rows; later layers win. Per the config rules, every knob involved lives in
  `config.json` (`cli.*` / profile files) — no new environment variables.
- **Introspection.** `brainrouter --dump-composition` (and a dashboard panel) prints the fully
  resolved tree the current profile boots — every mounted extension, every registration it
  contributed, every row's effective config and which layer set it. If a row is in the dump, a
  higher layer can replace it; that is the definition of done for "plug-and-play."
- **The loop is a row too.** The default turn driver registers as the `agent-loop` row behind
  `IAgent` (D4), so even the loop can be replaced from a profile — the last hard-coded privilege
  disappears.

### D12 — Services are profiles: microservice-ready, monolith-default

The standing repository decision is a modular monolith with enforced boundaries, and this ADR does
not reverse it. What D1–D11 quietly make possible is stated here as a commitment: **a service is a
profile** — a composition that mounts a *subset* of the rows — and **a seam is a permissible
process boundary**. Concretely:

- **Remote bindings.** Any row whose contract is a capability seam (a port, a world, a dialer, a
  registry-backed service like the shaper or the session-title provider) may be bound to a
  **remote implementation**: the row's config names a transport endpoint instead of an in-process
  module, and a generated client/server pair speaks the seam's typed contract over it. Consumers
  cannot tell the difference — that is the definition of the seam being real.
- **Service profiles.** Alongside `desktop`/`cli`/`mcp`/`fleet`, profiles may describe
  processes that mount only one subsystem — a provider-gateway service, a relay-edge service, a
  rate-shaper, a review worker, a memory engine. This is not greenfield: the deploy tree already
  ships per-subsystem images and stacks (`deploy/brain/Dockerfile`, `deploy/stt/Dockerfile`,
  `deploy/pentest/Dockerfile` + its proxy, `deploy/tunnel/docker-compose.tunnel.yml`,
  `deploy/postgres/`, `deploy/stack/`, and the dev/full compose files). Today each image boots a
  bespoke entrypoint; under D12 **an image boots a profile** — the Dockerfile's only job is "run
  the loader with profile X", so the compose files become materializations of profile sets and a
  new service is a new profile row plus an image tag, not a new entrypoint to hand-maintain.
- **The split is reversible.** Because the boundary is a config binding, an install can run
  everything in one process (default, and the only mode most installs should run), split one hot
  subsystem out under load, and merge it back — without code changes. `--dump-composition` shows
  which rows are remote-bound, so the deployed topology is inspectable the same way the plugin
  tree is.
- **Boundary discipline unchanged.** Seams that are *not* declared remote-capable (anything
  sharing in-process state, e.g. the transcript store's hot path) must say so in their contract;
  a profile binding such a row remotely is a boot error, not a surprise at runtime.

This is "microservice-ready, not microservice-mandatory": the monolith stays the product; the
profiles make the cut lines real and load-tested instead of aspirational.

### D13 — Feature-parity program: every capability of the studied reference harness, as extensions

A deep study of the reference harness architecture (docs + package tree) yields a capability
inventory that D1–D12 make adoptable **as extensions on the new runtime rather than core edits** —
each parity feature is itself a proof that the plugin system works. The matrix below is the
program of record; every row lands as one or more PRs registered through the D7/D8/D9 surfaces.

**Execution capabilities**

| Capability | BrainRouter today | Action |
|---|---|---|
| **Code Mode** — the model writes one program against generated tool bindings (`run_code`); worker treated as a hostile peer; dual budgets (event-loop-utilization compute meter + wall clock), output caps; sub-dispatches carry a parent token through the tool pipeline | none | **Adopt (flagship).** Rides D8: sub-dispatches enter the same guarded pipeline; containment stated as bash-equivalent, not a security boundary. |
| **Persistent PTY terminals** — `terminal_open/send/read/signal/list/close`; exact-owner fencing; one active send; sessions survive plugin reload; background sends ride the jobs seam | no PTY (a known CLI-orchestration gap) | **Adopt.** Fills the standing PTY gap; complements one-shot `run_command` rather than replacing it. |
| **Spill store + spill policy** — oversized tool output persisted whole; model sees bounded head/tail + opaque locator + retrieval hint; policy is a post-execute plugin, best-effort | truncation only | **Adopt.** Compose with the existing redaction chokepoint before persistence. |
| **Jobs seam** — kind-extensible background jobs (`job_list/output/kill`), owner isolation, completion notices, per-owner concurrency cap | durable background tasks + fleet queue (separate vocabularies) | **Unify** under one job vocabulary; existing systems become kinds. |
| **Sandbox honesty** — enforcement reported as `full`/`partial` fact; per-backend denial *dialects* (never a cross-backend union); runner-failure checked before denial; per-call policy, not per-provider | sandbox on/off, fail-closed | **Adopt principles** into the exec guard + D10 worlds. |

**Session capabilities**

| Capability | BrainRouter today | Action |
|---|---|---|
| **Event-sourced transcript** — append-only typed event log as the single source of truth; derived, frozen message history; surface `replace` ops for compaction; "model-visible ⟺ logged" runtime invariant | transcript + history array + pairing sanitizer | **Adopt as direction** (extends D4's invariant): new model-visible inputs become typed transcript events; surface-replace becomes the one compaction mutation. |
| **Session fork + lineage** — fork at a turn boundary (rejects mid-turn), parent/seed headers, descendant-forest tracing | none | **Adopt.** |
| **Session query tools** — `session_search`, `session_event_search`, `session_trace`, `session_event_read` over live-preferred corpus; FTS provider; opt-in, not default-mounted | host-side transcript search only | **Adopt** as opt-in agent tools, workspace-authorized. |
| **Session references** — @-mention another session as bounded, explicitly *untrusted* snapshot context (id-authoritative, budget-capped, no recursive propagation) | session-scoped artifacts/annotations | **Adopt**; compose with memory recall. |
| **Crash recovery + format refusal** — orphan turns closed with a synthetic `interrupted` end, never truncated; unknown/newer log formats refused with direction ("upgrade" vs "no downgrade path") instead of silently gutted | partial | **Adopt.** |
| **Message feedback** — editable per-message rating/note sidecar (never model-visible) + log-only `/feedback`; optional telemetry release | none | **Adopt** — becomes a signal source for the ADR-020 self-improvement loop. |
| **Title pinning** — an explicit user rename permanently stops automatic title generation | auto titles | **Adopt rule.** |

**Context management**

| Capability | BrainRouter today | Action |
|---|---|---|
| **KV-cache-aware compaction** — summarization replays the conversation's own system prompt/tools/messages verbatim + one appended instruction, reusing the provider's warm prefix; a `purpose: 'compaction'` flag on the call | compaction without prefix reuse | **Adopt technique.** |
| **Model-free pruning pre-pass** — over-budget tool results rewritten to head+marker+tail before any summarization; idempotent; may resolve pressure with no model call | none | **Adopt.** |
| **Token meter service** — replay-aware measurement folded from the durable log, shared by all pressure-sensitive consumers | per-surface context ring (with known staleness bugs) | **Adopt** — one accounting authority also retires the pinned-100% bug class. |
| **Cache-safe dynamic context** — dynamic prompt material logged as durable snapshots only when changed, so the static prefix stays byte-stable across turns | per-turn re-render | **Adopt.** |

**Delegation and orchestration**

| Capability | BrainRouter today | Action |
|---|---|---|
| **Continuable children** — durable child session + process-local activation; `send_message` enqueues a FIFO turn; `interrupt_agent`; cold resume folds the descriptor without any provider dispatch | fleet spawn + federation inbox | **Adopt**, mapped onto the existing federation/session machinery. |
| **Report/settled provenance split** — what the child *said* (relay) vs what the manager *observed happen* (notice) are distinct message sources, never merged | children return text | **Adopt.** |
| **External-agent child providers** — other CLI agents driven as subagent providers behind the one delegation contract | planned adapters (multi-CLI orchestration gap) | **Adopt** — the parity program's answer to that gap; changing provider changes transport, not the contract. |
| **Workflow discipline** — hook misuse is fatal and re-thrown (never dissolves into a `null` child failure); cancelled runs settle within a bounded grace even if the script never does; events are observe-only snapshots that cannot leak the live run handle | workflow engine shipped | **Adopt discipline.** |

**Policy and interaction**

| Capability | BrainRouter today | Action |
|---|---|---|
| **Permission presets** — named bundles of sandbox mode + approval policy; `custom` is derived-only, never selectable; selection is a log-only event preceding the knob writes | scattered knobs | **Adopt.** |
| **Approval audit** — fail-closed outcome union (`unavailable`, never an open gate); paired asked/decided log events; `never` enforced inside the service so no listener can bypass it | exec approval | **Adopt audit + fail-closed union.** |
| **User questions seam** — batched structured questions with intents that change presentation only; the affirmative option is *named*, never positional | none | **Adopt** (`ask_user_question`). |
| **Plan mode as a logged fold** — pure fold over log-only events, zero live mirror; narration appended only when the last request described the other state; `exit_plan_mode` reviewed via the questions seam | planner surface (ADR-038) | **Adopt the fold + review flow** under the planner. |
| **Session-native reminders** — schedule tools with a catch-up policy (only the latest due occurrence per recurring rule; at-least-once, maintenance-phase delivery, never interrupts a turn) | cron-style scheduled tasks | **Unify**: session-local reminders adopt these semantics; infra cron stays for org jobs. |
| **Command log events** — `command/run`/`done` with `sourceEventSeq` naming the authoritative domain event, so UIs fold command + result without parsing text | slash commands | **Adopt pattern.** |

**Platform and diagnostics**

| Capability | BrainRouter today | Action |
|---|---|---|
| **Runtime-invariants registry** — package-owned invariant companions, exhaustive across the workspace (empty ones must explain why), regex-filtered activation, a mechanical verify gate | golden inventory tests | **Adopt** — generalizes the golden tests into a first-class system. |
| **Generated, drift-checked docs** — config/tool/persistence/event catalogs generated from source; doc type snippets asserted byte-equivalent against code | hand-maintained rules handbook | **Adopt generation** for the catalogs; the handbook keeps the judgment content. |
| **Out-of-process SDK** — JSON-RPC protocol + client to drive the harness from another process; headless one-shot profile | MCP serve + CLI | **Formalize** as a typed SDK surface on the D11 profiles. |
| **Secrets discipline** — config carries *references*, never secrets; per-operation resolution (rotation reaches the next request); write-only settings fields with path-op writes + revision CAS so a redacted client can never silently delete secrets | JIT secret leases + write-only fields | **Unify** into one credential-reference contract. |
| **Runtime self-modification** — approval-gated tools letting the agent define/run/retract dynamic plugins in its own live runtime | none | **Evaluate last** — powerful but demands the D9 disposal story plus org-policy gating before any exposure. |

**Adopted conventions** (applied to all new code under this ADR): errors are fields on resolved
results, not rejections; defaulting is an explicit `resolve(request) → spec` step, never a hidden
`??`; misconfiguration fails loud at load; guard chains are monotonic (no "allow" result can
reverse a denial, so listener order can't grant permission); data decides, not listener order;
cross-boundary ids are branded opaques; closed unions end in exhaustiveness checks; orthogonal
outcomes (timeout vs abort vs signal vs exit) are reported independently.

**Waves:** W1 — context + execution quick wins (spill, pruner, token meter, permission presets,
terminals). W2 — session plane (fork, query tools, references, feedback, invariants registry) +
the D14 transparency plane. W3 — delegation (continuable children, external-agent providers, Code
Mode). W4 — platform (SDK, generated catalogs, reminder unification, self-modification
evaluation). Each wave lands only on the D1–D12 surfaces; a parity feature that would require
patching core is a signal the runtime work is incomplete, not a license to patch.

### D14 — The glass box: a human can watch, inspect, and replay the whole process

The reference harness's most product-defining property is not any single feature — it is that **the
process is transparent to the human by construction**. That falls out of the architecture, not the
UI: because the transcript is an append-only event log and every model request is a pure function
of it (D13's "model-visible ⟺ logged"), the UI can show the truth rather than a narration of it.
BrainRouter adopts the plane as five commitments:

1. **Every request is inspectable, exactly.** The per-request header event logs the *rendered*
   system prompt, tool schemas, and route/config actually sent. A human opens any step and sees
   precisely what the model saw — not a reconstruction. This retroactively strengthens debugging,
   review audits, and the ADR-033 agent trace: "why did it do that?" becomes a read, not a guess.
2. **A trajectory ledger beside the chat.** A turn-aware, virtualized event ledger — turn rules,
   step markers, selectable user/assistant/tool/nested-subtool records — with a per-record
   inspector (input, output, token usage, duration, timing) and a fixed timeline overview
   projecting each record's real start/duration, assistant spans split into **TTFT vs decode**,
   wheel-zoom and interval drag-focus, tail-following that suspends while the human inspects
   history and pages older prefixes on demand. One honesty rule inherited verbatim: **in-flight
   work shows a start marker, never a fabricated live duration**, and unloaded history is an
   explicit ellipsis, never an invented span.
3. **Tool activity is structured data, not prose.** Tool calls/results carry semantic *render
   intents* (terminal, diff, read, search, web — pure functions of args, logged with the call), so
   the UI renders a diff card, a terminal card with its exit-status pill, a search-hit list — and
   an unknown intent falls back to text instead of breaking. Call/result pairing and sub-call
   topology stay runtime-authoritative; per-tool views register by wire name through the panel/
   slot registries (D5/D8), so an extension's tool arrives with its own presentation. A
   "deliverables" fold recognizes a turn's mutations *by render intent, not tool name*, and
   presents the produced files as a row.
4. **The human sees more than the model, and knows the difference.** Log-only events — commands,
   approval asked/decided pairs, permission-preset selections, feedback, compaction brackets — are
   rendered to the human but never enter model context. The ledger visibly distinguishes
   model-visible, log-only, and shadowed-by-compaction records, so "what the model knew" and "what
   happened" are separately answerable. Approval prompts attach to the already-streamed tool call
   by id rather than re-rendering a copy that could drift from what is approved.
5. **Live state is pushed as consistent wholes.** Session-derived state (stats like turn/step
   counts and first-token/decode wall times, goals, todos, plan mode) reaches clients as
   whole-value projection snapshots at one consistent log position — never client-side folds of
   raw events — so every surface (desktop, dashboard, CLI) shows the same truth at the same seq.
   Composition transparency closes the loop: `--dump-composition` (D11) and the plugin-inventory
   panel show *what is running*, the generated catalogs (D13) show *what it can do*.

Delivery rides existing surfaces: the desktop gains the trajectory panel and request inspector via
`PanelRegistry`; the dashboard review console reuses the same record components for the agent
trace; the CLI gets the text projection of the same ledger. One rule binds all of it: **the UI
renders the log; it never keeps private state the log cannot reproduce** — a reload, a replay, or
another surface must show the same process.

---

## 3. Ownership

| Concern | Owner | Does not own |
|---|---|---|
| Provider registry lifecycle and mutation API | `packages/core/src/provider/providers/` | Provider wire behaviour (owned by `ProviderDefinition`), adapter implementation |
| `StreamChunk` protocol definition and core consumption | `packages/core/src/agent/transport/` | Native SSE translation (owned by provider adapters) |
| Capability port interfaces and default implementations | `packages/core/src/extension/builtin/` | Tool dispatch logic (stays in `invokeBuiltinToolRuntime`), policy/approval logic |
| `IAgent` interface and phase hook execution | `packages/core/src/agent/` | Agent class implementation details, host-specific agent configuration |
| Product-wide registry interfaces | `packages/core/src/registry/` (new) | Per-surface handler implementations (MCP, CLI, desktop, API) |
| `IMemoryStoreComposite` interface | `brainrouter/src/memory/` | Store backend implementation (Postgres, SQLite, etc.) |
| Extension host API surface | `packages/core/src/extension/host.ts` | Extension activation lifecycle (owned by `loader.ts`), host-specific extension discovery |
| Guarded tool pipeline stages | `packages/core/src/extension/builtin/` (pipeline module) | Individual tool handlers, guard rule content (stays in `exec/guard/`) |
| Scoped contexts and capability presets | `packages/core/src/extension/host.ts` + `orchestration/roles/` | Session lifecycle (owned by the agent), preset *content* (product decision per role) |
| `ExecutionWorld` binding and selection | `packages/core/src/runtime/` | Port implementations (each world's), sandbox profile generation (owned by `exec/runtime/`) |
| Profiles, layering, `--dump-composition` | `packages/core/src/config/` + one shared boot loader | Per-host UI for profile editing, extension bundle publishing/distribution (plugin-marketplace scope) |

---

## 4. Alternatives rejected

### A. Replace ExtensionHost with a new plugin system

Rejected. The existing host has four typed registrars, a loader, and shipped extensions. A new system
would break every extension for no gain — the problem is what the host cannot register, not how it
registers.

### B. Make invokeBuiltinToolRuntime a class hierarchy

Rejected. A `ReadFileTool` / `WriteFileTool` / `RunCommandTool` class per case would multiply types
without adding swappability. The capability port pattern extracts the side effect first (D3, the
switch stays as dispatcher during that slice); the switch then dissolves into **registry entries
sharing one guarded pipeline** (D8) — plain registrations, not a class hierarchy. The rejection is
of inheritance as the mechanism, not of removing the switch.

### C. Keep PROVIDER_REGISTRY frozen and add a separate extension provider map

Rejected. This is what the codebase does today — `ExtensionHost.registerProvider` writes to a
parallel store. Two provider maps means consumers must check both, registration order is ambiguous,
and disposal cannot atomically remove from both.

### D. Put phase hooks on the Agent class, not the extension host

Rejected. Phase hooks are an extension capability — they let extensions observe and modify the turn
loop. Putting them on `Agent` directly would mean extensions need an `Agent` reference, which breaks
the `IAgent` extraction and couples extensions to the concrete class.

### E. Generate PanelId from a config file instead of a registry

Rejected. A config file is still build-time. The point of `PanelRegistry` is that an extension loaded
at runtime can contribute a panel without a rebuild or a code change in `panelCatalog.ts`.

---

## 5. Dependency-ordered delivery board

Each row is a separate pull request. A checked row requires its own evidence. Merging the accepted
decision record checks only A41-0; it makes no implementation claim.

- [ ] **A41-0 — Accept this decision.** ADR and index only; no runtime claims.
- [ ] **A41-1 — Extract IAgent interface.** Pull the interface out of the concrete `Agent` class.
  Pure type seam — no behaviour change, no new methods. Hosts switch imports from `Agent` to `IAgent`.
- [ ] **A41-2 — Live provider registry.** Replace `PROVIDER_REGISTRY: ReadonlyMap` with
  `ProviderRegistry` class. Rewire `ExtensionHost.registerProvider` to call
  `ProviderRegistry.register()`. All existing consumers read through the new class with the same API.
- [ ] **A41-3 — Capability ports.** Extract `FilesystemPort`, `ShellPort`, `SubprocessPort` from
  `invokeBuiltinToolRuntime`. Wire default implementations. Register on `ExtensionHost`.
- [ ] **A41-4 — Phase hooks and extension host evolution.** Add `registerPhaseHook()` and
  `registerDisposable()` to `ExtensionHost`. Wire `beforePhase` / `afterPhase` into the agent turn
  loop. Unify provider registration through `ProviderRegistry`.
- [ ] **A41-5 — Provider-neutral streaming protocol.** Introduce `StreamChunk` union. Build the
  OpenAI SSE adapter. Switch core consumers to `StreamChunk`. Add native provider streaming paths.
- [ ] **A41-6 — IMemoryStoreComposite.** Compose the 12 store interfaces. Implement on
  `MemoryEngine`. Remove `as unknown as *Store` casts.
- [ ] **A41-7 — Product-wide registries.** `McpToolRegistry`, `CommandRegistry`, `PanelRegistry`,
  `ApiRouteRegistry` — four surfaces, one PR per surface or one combined PR if the pattern is small
  enough.
- [ ] **A41-8 — Guarded tool pipeline; the switch dissolves.** Lift approval/policy/sandbox/guards
  into the shared pipeline; builtin tools re-register as registry entries; `McpToolRegistry`
  becomes a projection. Waterfall `next()` semantics land on `pre-step` / `provider-call` /
  `pre-execute` / `post-execute`, with the transcript ("model-visible means logged") assertion.
- [ ] **A41-9 — Universal disposables + scoped contexts.** Every registrar returns a handle;
  extension unload unwinds in reverse order; `host.scope(sessionKey)` + capability presets; roles
  consume presets.
- [ ] **A41-10 — Execution worlds.** `ExecutionWorld` binding of the three ports + sandbox
  resolver; `local` default; worktree/container backends re-expressed as worlds.
- [ ] **A41-11 — Profiles and composition dump.** Profile files for the four hosts, layered
  overlays targeting rows by id, `--dump-composition`, and the default loop driver registered as a
  replaceable row.
- [ ] **A41-12 — Remote seam bindings + service profiles.** Typed remote binding for
  remote-capable seams (boot error for the rest); one existing subsystem (the provider gateway is
  the natural first, per ADR-043) re-expressed as a service profile; its Docker image reduced to
  "loader + profile"; dev compose regenerated from profile sets.
- [ ] **A41-13 — Parity wave W1** (spill store + policy, tool-result pruner, token meter,
  permission presets, persistent terminals) — each as an extension, no core edits.
- [ ] **A41-14 — Parity wave W2** (session fork + lineage, session query tools, session
  references, message feedback, runtime-invariants registry).
- [ ] **A41-15 — Parity wave W3** (continuable children + send/interrupt/report, external-agent
  subagent providers, Code Mode).
- [ ] **A41-16 — Parity wave W4** (out-of-process SDK, generated drift-checked catalogs,
  session-native reminder unification, self-modification evaluation — evaluation may conclude
  "no").

---

## 6. Acceptance

### 6.1 Architecture invariants

- `PROVIDER_REGISTRY` no longer exists as a `ReadonlyMap`. `ProviderRegistry` is the single source of
  truth.
- `invokeBuiltinToolRuntime` contains no direct `fs.*` calls — all filesystem I/O goes through
  `FilesystemPort`.
- `IAgent` is exported from `packages/core/src/agent/` and hosts import it instead of `Agent`.
- `ExtensionHost` has `registerPhaseHook` and `registerDisposable` methods.
- No `as unknown as *Store` casts remain in `brainrouter/src/memory/engine.ts` or domain
  `backend.ts` files.
- The MCP server tool handler contains no `switch` — it iterates `McpToolRegistry`.
- The REPL command dispatch contains no sequential `tryHandle*Command` chain — it walks
  `CommandRegistry`.

### 6.2 Compatibility

- Every existing extension activates and runs without modification.
- Every existing provider appears in `ProviderRegistry` at startup with the same `id` and
  `ProviderDefinition` shape.
- Every existing CLI slash command resolves through `CommandRegistry` with the same behaviour.
- Every existing desktop panel renders through `PanelRegistry` with the same `PanelId`.
- Every existing API route mounts through `ApiRouteRegistry` at the same path.

### 6.3 Plug-and-play evidence

- A provider can be registered, replaced, and disposed at runtime without a restart.
- An extension can register a phase hook that observes `turn-start` and `turn-end`, and a waterfall
  handler on `pre-execute` that rewrites one tool's arguments and rejects another's call entirely.
- An extension can register a custom `FilesystemPort` that intercepts `read_file` and `write_file`.
- An extension can register a new panel that appears in the desktop views chooser without editing
  `panelCatalog.ts`.
- A builtin tool and a third-party tool traverse the **same** guarded pipeline — demonstrated by a
  policy stage log line for both — and registering a tool requires no edit outside the registering
  module.
- Unloading an extension removes every registration it made (tools, hooks, providers, panels) with
  zero leaked handlers; loading it again restores them — no restart.
- A capability preset applied to one session changes that session's tool list and ports while a
  concurrent session is unaffected.
- Switching the execution world to the container backend moves `run_command`, background shells,
  and worker spawns together, with no per-tool changes.
- `--dump-composition` prints the resolved tree for each of the four host profiles, and a
  workspace-level overlay replacing one row (e.g. the session-title provider or the agent-loop
  driver) demonstrably takes effect on next boot.
- A dev-build assertion fails when a hook injects model-visible content without a matching
  transcript entry.
- One subsystem runs both in-process and as a remote-bound service from the *same* code, switched
  only by profile config; consumers observe no contract difference. Binding a
  non-remote-capable row remotely fails at boot with the row and reason named. The subsystem's
  Docker image contains no bespoke entrypoint logic beyond "loader + profile name".

Not judged by: performance benchmarks, streaming throughput numbers, or UI design quality.

---

## 7. Consequences

**Positive:**

- Providers, capability ports, phase hooks, and dispatch tables are all swappable at runtime through
  one consistent registration pattern on `ExtensionHost`.
- Hosts depend on `IAgent`, not `Agent` — the concrete class can evolve without breaking host
  imports.
- The 1,600-line `invokeBuiltinToolRuntime` monolith gains seams without being rewritten — each
  capability port is independently swappable.
- The 73 `as unknown as *Store` casts are replaced by a typed composite interface — the type system
  enforces what the store provides.
- Adding a tool, command, panel, or route no longer requires editing a switch, an if-chain, a static
  array, or a server entry point.

**Costs and risks:**

- Seven slices, each touching a different workspace — the blast radius is wide but each slice is
  independently mergeable.
- `ProviderRegistry.register()` introduces runtime mutation where there was none — concurrency safety
  must be verified (the registry must be safe to read while a registration is in progress).
- `StreamChunk` is a new protocol — every provider adapter must implement the translation, and the
  OpenAI SSE adapter must be maintained as the provider's wire format evolves.
- `IMemoryStoreComposite` requires the store backend to implement all 12 interfaces — a backend that
  cannot provide one capability must declare it explicitly, which is a behaviour change for backends
  that currently silently fail the cast.
- Phase hooks add synchronous interception to the turn loop — a slow hook degrades turn latency. The
  hook API should document this constraint and consider a budget.
- Waterfall chains make handler *order* semantic — two extensions rewriting the same payload can
  conflict. Order is the registration order of the composition (D11's layer order), which the dump
  makes visible; a debugging aid should name the handler that rejected or rewrote a payload.
- Dissolving the switch (D8) moves approval/guard logic through a shared pipeline — a regression
  there affects every tool at once. The pipeline slice needs the guard test suite run against every
  builtin tool, not just `run_command`.
- Profiles introduce a second place behavior is defined (config, not code). The dump command and
  "row id or it does not exist" rule are the mitigations — nothing may mount outside the dumped
  tree.
- Remote bindings (D12) put a network on a path that was a function call — latency, partial
  failure, and version skew between the two sides of a seam become real. Mitigations: seams
  declare remote capability explicitly, contracts are versioned with the registry row, and the
  monolith remains the default so the split is always an *operator's* informed trade, not the
  product's baseline complexity.

> The result is a runtime where swapping a provider, a capability port, or a dispatch table is the
> same gesture as registering an extension — because it is the same API.

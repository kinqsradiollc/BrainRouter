# ADR-050 — External agents as live sessions, not one-shot shells

**Status:** IMPLEMENTED (P1–P5, 0.4.22) — the `AgentSessionPort` seam ships with all agents working
unchanged (P1), the three structured transports stream live (P2a Claude stream-json, P2b Codex
app-server, P2c ACP), permission posture + the `InteractionPort` approval bridge land (P3), the engine
selects each agent's declared transport behind the opt-in `cli.agents.liveSessions` knob (P4), and
hosted agents become isolated-home instances that may declare their own live transport — so live
sessions reach bring-your-own agents, not just the built-in catalog (P5). · **Builds on:** ADR-047 D2 (agents as engines —
this ADR is the protocol decision §3 of that ADR explicitly deferred), ADR-041 (registry discipline,
W3 external-agent workers, the interrupt cascade), ADR-042 (worktree runtimes), and
`packages/agent-protocol` (the host's own event/command/interaction vocabulary). · **Informed by:**
a study of contemporary agent-harness control surfaces (2026-08); no external project is named or
copied — this ADR adopts *shapes*, grounded in our own code. · **Supersedes:** the "honest scope"
paragraph of ADR-047 D2 (an engine turn is a terminal answer), deliberately.

**Date:** 2026-08-28

> An installed coding agent (Claude Code, Codex, Gemini CLI, OpenCode, …) can already sit in three
> of our seats: the main loop's **engine** (ADR-047 D2), a delegated **worker** (ADR-041 W3), and a
> **worktree runtime** (ADR-042). All three drive it the same two crude ways: a one-shot headless
> spawn that pipes the whole flattened conversation and reads stdout until exit, or a PTY watched
> with regexes that types `y\r` at anything matching `/approve/i`. Meanwhile the agents themselves
> now publish structured session protocols — the open **Agent Client Protocol (ACP)** over stdio,
> Codex's **app-server** JSON-RPC, Claude Code's **stream-json** headless sessions. Speaking those
> protocols turns a black-box answer into a live session: streamed output, visible tool activity,
> plan steps, *remote-able* permission requests, cheap incremental turns, and real interrupts. This
> ADR decides the seam, the transports, the approval bridge, and the scope.

---

## 1. Where the code is today

- **The engine is one-shot and blind.** `packages/core/src/agent/transport/externalAgentEngine.ts`
  spawns `claude -p` / `codex exec` / `opencode run` / `gemini -p`, pipes the **entire flattened
  conversation every turn** (`flattenMessagesToPrompt`), collects stdout until exit, and returns it
  as one terminal answer — `toolCalls: undefined`, one synthetic stream delta, `finishReason:
  'stop'`. Its own header admits the scope: "there is no channel to hand a BrainRouter tool call
  back." Cost grows quadratically with conversation length; nothing the agent *did* is visible.
- **Interactive driving is regex-over-PTY.** The adapter catalog
  (`packages/core/src/agent/adapters/catalog.ts`) carries `statusPatterns` (`blocked:
  [/approve/i, …]`) and `controls: { approve: 'y\r' }` — the worktree-runtime/console path infers
  agent state from terminal text and answers permission prompts by typing `y`. It works until any
  agent rewords a prompt, and it can never distinguish "approve a file edit" from "approve a shell
  command".
- **Resume args exist but are unused by the engine.** Every catalog entry declares
  `resumeArgs` (`claude --resume <id>`, `codex resume <id>`), yet no session id is ever captured,
  so nothing resumes.
- **The seams this ADR needs already shipped.** W3 workers run under `SubprocessPort` on the
  interrupt cascade (`orchestration/tools/registry.ts` `registerInterruptibleAgent`); worktree
  runtimes hold a persistent child with pending turns (`runtime/backends/hostedCli.ts`); and
  `packages/agent-protocol` already defines the one vocabulary every host renders —
  `InteractionRequest/Response` with `ExplicitConfirmDecision = approved | declined | dismissed`
  (`interaction.ts`), `PlanStepView`/`PlanUpdateView` (`planning.ts`), typed events and envelope
  stamping. Native agent traffic has somewhere to land; nothing receives it yet.
- **Our tools already flow INTO the agents** via the catalog's `integration.mcp` entries
  (`claude mcp add … brainrouter mcp-proxy`, same for codex/gemini) — that direction is solved and
  out of scope here. The missing direction is *their* session state flowing back to *us*.

---

## 2. Decisions (the part that needs approval)

**D1 · One session seam, three consumers.** Introduce an `AgentSessionPort` in `packages/core`: a
persistent per-agent session with a canonical lifecycle — `open` (spawn or attach) → `prompt`
(one *incremental* user turn) → streamed events → `interrupt` → `close`, plus an opaque
per-session `resumeCursor` the port persists and replays on reopen. Every event it emits is
normalized **into the `agent-protocol` vocabulary we already render** — text deltas as events,
agent tool activity as read-only transcript narration, plan updates as `PlanUpdateView`, permission
requests as `InteractionRequest`. The engine slot (`callExternalAgentEngine`), W3 workers, and
worktree runtimes all consume this one seam; the port registers on the interrupt cascade like any
child. *Acceptance: the same session port instance serves an engine turn and a worker delegation,
and Stop lands through the cascade in both.*

**D2 · Transports are catalog data, not hand-wired code.** The adapter catalog gains a declarative
`session` descriptor per agent naming its transport: `acp-stdio` (the open Agent Client Protocol —
one generic client unlocks Gemini CLI and every other ACP-speaking agent), `codex-app-server`
(JSON-RPC over stdio via `codex app-server`), `claude-stream-json` (`claude -p --input-format
stream-json --output-format stream-json`, the CLI's own structured session mode), or `pty`
(explicit fallback — today's behavior, demoted from default to declared last resort). Wire
protocols over vendor SDKs: each transport is a small client we own against a published protocol,
not a bundled SDK dependency. An agent whose declared transport fails to handshake falls back
loudly to `pty` with a named reason — never silently. *Acceptance: adding session support for a new
ACP-speaking agent is a catalog entry, zero new transport code.*

**D3 · Approvals cross the wire as interactions, mapped from our permission modes.** A session's
permission posture is derived from the host's existing execution mode (safe/plan-first/yolo
semantics), translated at `open` time into each protocol's native permission configuration; what
still escalates arrives as a typed permission request and surfaces as an `InteractionRequest` —
rendered by the same Desktop/CLI/mobile surfaces that render every other interaction, answered
`approved | declined | dismissed`, with an explicit "approve for this session" variant where the
protocol supports it. Unmapped or unrecognized request kinds **default-deny** with a visible
notice. The `y\r` control and `/approve/i` status regexes are retired wherever a structured
transport is active. *Acceptance: an agent-side file-edit request appears as an interaction on the
Desktop, Decline actually declines it, and nothing ever auto-types `y`.*

**D4 · Turns become incremental, visible, and interruptible.** With a live session, the engine
sends **only the new user message** per turn (the agent holds its own context; our transcript
remains the source of record), streams real deltas instead of one blob, narrates the agent's tool
calls and plan steps into the transcript read-only, and interrupts via the protocol's cancel —
process kill remains only as escalation after a bounded grace. The router still treats engine picks
as terminal (`withFallbacks:false`; ADR-047's guarantee that a subscription seat is never swapped
for an API bill is unchanged). *Acceptance: a 40-turn engine conversation does not re-send its
history each turn, its tool activity is visible live, and Esc cancels mid-turn without killing the
process.*

**D5 · Instances, not binaries (last phase).** A hosted-agent entry becomes an *instance*: the same
CLI may appear N times with isolated homes (per-instance config-dir/home env such as
`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), instance id — not binary name — as the routing key, and
per-instance env kept in the settings store like any provider secret. This is config + env
isolation only; account pairing UX and mid-thread account switching rules are follow-up product
work, not this ADR. *Acceptance: two instances of one agent CLI with different homes run
concurrently without sharing auth state.*

---

## 3. What this is not

- **Not a migration of our own loop.** BrainRouter's own agent remains the primary engine and the
  default; external sessions are opt-in seats. Our internal host wire stays
  `packages/agent-protocol` — we *normalize into* it; we do not replace it with an external
  protocol (ADR-047 §3's stance, upheld).
- **Not tool interop beyond narration.** The external agent runs its own tools in its own process;
  we render what it reports. Our tools reach it through the existing MCP integration path, and
  proxying BrainRouter tool calls *into* a foreign session is explicitly out of scope.
- **Not the remote/mobile IDE.** Approval interactions ride whatever surfaces already render
  interactions (including the mobile relay's scoped approvals); building richer mobile control is a
  separate ADR.
- **Not a PTY removal.** Terminals stay for agents with no structured mode and for the user-facing
  console; only *state inference and approval typing* over PTY are retired where a transport exists.
- **Not new vendor SDK dependencies.** Transports are thin clients against published wire
  protocols; a vendor SDK enters only if a protocol is unpublishable otherwise, as its own decision.

---

## 4. Dependency-ordered delivery board

Each row is one reviewable PR; P2a/P2b/P2c are independent once P1 lands.

- **P1 — The seam** (D1) — ✅ #1613. `AgentSessionPort` + event normalization into `agent-protocol`
  types + `resumeCursor`; the `stdio-oneshot` transport is byte-identical to the pre-ADR-050 spawn,
  so the seam shipped with all agents working unchanged.
- **P2a — Claude stream-json transport** (D2/D4) — ✅ #1614. Structured session client, incremental
  turns, streamed deltas, tool narration, `--resume`.
- **P2b — Codex app-server transport** (D2/D4) — ✅ #1615. JSON-RPC client, thread start/resume, the
  turn/start response as the turn boundary.
- **P2c — ACP client transport** (D2/D4) — ✅ #1615. Generic ACP-stdio client; Gemini CLI as the
  proving agent; catalog-declared for any other ACP speaker.
- **P3 — The approval bridge** (D3) — ✅ #1616. Permission-mode → per-protocol posture mapping,
  permission requests routed through an `InteractionPort` (`confirmExplicit` lossless, fail-closed),
  default-deny when no port is wired.
- **P4 — Engine transport selection** (D1/D4) — ✅ #1616. `callExternalAgentEngine` drives the port
  and selects each agent's catalog-declared transport behind the opt-in `cli.agents.liveSessions`
  knob; undeclared agents stay one-shot. (The W3 worker adapter and `HostedCliAgentRuntime` already
  route through the engine, so they inherit the seam; deepening their streaming is follow-up work.)
- **P5 — Instances + bring-your-own transports** (D5/D2) — ✅ this PR. Hosted entries become
  instances (entry name = routing key), each with an isolated-home `env` merged over `process.env`;
  `agentId` carries the routing key to the spawned process. A hosted entry may also **declare its own
  live `transport`** (`acp-stdio` for any ACP-speaking CLI, or a vendor transport for a compatible
  one) with `transportArgs`, so live sessions reach bring-your-own agents — not just the five
  built-in catalog entries — with **zero new transport code** (D2's promise, extended to the user
  catalog). Config + env isolation only.

---

## 5. How this will be judged

1. An engine conversation with an installed agent CLI **streams live**, shows the agent's tool
   activity, and its 40th turn sends one message, not forty.
2. A permission request raised inside the external agent is **answered from a BrainRouter
   surface** — approve, decline, approve-for-session — and no code path types `y` at a regex.
3. Killing the transport mid-turn produces a *named* fallback to PTY, never a silent one; Stop
   interrupts via the protocol and the cascade in every seat (engine, worker, runtime).
4. A new ACP-speaking agent goes from unsupported to session-driven with a **catalog entry only**.
5. Two instances of the same agent CLI, different accounts, run side by side without sharing auth.

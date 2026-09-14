# ADR-059 — Turn path: what the agent did, in the order it did it

**Status:** PHASE 1 IMPLEMENTED (0.4.22) — the `turn-step` event, the runtime emitters
(model calls, router fallbacks, guardrail re-prompts, provider-side activity, turn
end), transcript persistence, the desktop "Path" block (live and on reload) and the
CLI's guard/provider/end lines. Phase 2 (a TUI path panel, per-step drill-down, a
"why did it stop" summary line) is queued. · **Builds on:** the agent-protocol event
bridge (every host already renders `tool-start`/`tool-end`/`status`), the transcript
store (ADR-028 — named records the model never sees), ADR-057 (the desktop's tool
steps in the thinking stream), ADR-058 (provider-side activity on Matilda). ·
**Supersedes:** nothing.

**Date:** 2026-09-14

> A person watching a turn sees prose, a tool-calls card, and — while the turn runs — a
> "thinking…" strip that vanishes when it ends. Everything the runtime *decided* on
> their behalf is invisible: that it re-prompted the model twice because the model
> promised tools and ran none; that a provider's own search preempted the tools; that
> the router fell over to another model; that the turn ended because a guard's budget
> was spent rather than because the model was done. The decision: the runtime emits one
> ordered, provider-neutral **turn path** — model calls, provider activity, guardrails,
> tool calls, and the reason the turn ended — as a first-class event, keeps it in the
> transcript as a record the model never sees, and every host renders it the same way.

---

## 1. Where the code is today

- **Session `7ee4828c…:new-bef6ee2e…` (14 Sep 2026), read from its transcript.** Three
  turns on Matilda. Turn 1: the model promised to explore, ran nothing, the
  *promise-then-ask* guard re-prompted it, it answered "I don't have any tools". Turn 2:
  promise → guard → it **did** call `list_dir` (61 entries) and `list_agents`, then two
  messages later claimed it had no exploration tools; the *deliverable* guard fired;
  the turn ended on prose. Turn 3: two more guard re-prompts. The chat showed only the
  prose and one tool card. The guard records exist in the transcript
  (`role: 'user', name: 'guard'`) — `reconstructTranscriptRows` deliberately hides any
  user record with a `name`, and system records (`name: 'router'`) entirely — so the
  person had no way to learn that the runtime intervened five times.
- **What exists and where it stops.** `onStatusUpdate` carries one transient line
  ("Recovery: promised-tools-then-asked (1/2) — steering to discovery",
  "Router fallback: …") that the desktop shows in the work-line header for a moment
  and the CLI ticks past. `reasoning-delta` is live-only and cleared at turn end
  (ADR-057 put tool steps and Matilda's server-side activity there — visible while
  running, gone after). `cli.traceRequests` (ADR-041 D14) writes a per-request
  header to `request-trace.jsonl` for `/inspect` — off by default, CLI-only, and a
  request header is not a story. `tool-start`/`tool-end` are the one durable,
  host-neutral step signal, and they cover only tools.
- **The guards are many and bounded.** `turnLifecycleCoordinator`: empty-answer,
  preamble-without-action, promised-tools-then-asked (2 each), fan-out follow-through
  and differentiation (1 each), deliverable (1); `childProfileGuardPhase`: child-drain
  (auto-runs `wait_agents`), profile-stage and delegated-stage (`PROFILE_STAGE_GUARD_MAX`).
  Each pushes a `user`-role correction into the model's history and records it with
  `name: 'guard'`. When the bound is spent, the turn ends with whatever the model last
  said — which is what "why does it stop here?" looks like from the outside.

## 2. Decisions

**D1 · One event, `turn-step`, for the things a person would ask "what happened?" about.**
`{ kind: 'turn-step', step }` where a step is
`{ at, type: 'model' | 'provider' | 'guard' | 'end', label, detail?, ok?, attempt? }`.
`model`: one call to a provider/model — label `provider/model`, detail finish reason,
tool calls, output tokens, wall time; a router fallback is a `model` step with
`ok: false` naming the route it moved to. `provider`: activity the provider's platform
did on its own — Matilda's server-side `search`/`memory`/`assistant`(code), a safety
replacement, an early end. `guard`: a runtime guardrail re-prompted the model — the
guard's name, its attempt `n/max`, and its one-line reason. `end`: why the turn ended —
answered, ended without an answer, stopped at the tool-loop limit. Tool calls stay on
`tool-start`/`tool-end`; a host interleaves them into the same path by time. The
callback is `onTurnStep?` on `AgentCallbacks`; the bridge maps it like every other.

**D2 · Emitted by the runtime, so every provider gets the same path.** The emitters
live in `modelInvocationPhase` (the resilient call wrapper and the router's
`onFallback`), the two `continueWithGuard`s, and `runTurn`'s finalisation. A provider
contributes only `provider` steps, through a new `onProviderActivity` handler on the
native stream (an `activity` chunk on the provider stream, an `onActivity` hook on
the continuation driver) — Matilda is the first; an OpenAI-shaped provider simply
never emits one. No host-specific code decides what a step is.

**D3 · Persisted as a transcript record the model never sees.** At the end of a turn
the path is appended as `{ role: 'system', name: 'turn-path', content: <rendered>,
steps }`. `loadHistory` replays only `user`/`assistant`/`tool` roles, so the record
can never reach a provider; `reconstructTranscriptRows` turns it into a `turn-path`
row so a reopened session shows the same path it showed live. The rendered `content`
keeps exports and search readable without the structured `steps`.

**D4 · Rendered as a compact, ordered, collapsible block — the same shape everywhere.**
Desktop: a "Path" block per turn in the thread (live-updating; the tool steps join it
as they start and complete), collapsed to `N steps · <how it ended>`, expanding to
one line per step with the step's kind, label, detail and outcome. CLI: guard,
provider and end steps print as dim notice lines in the scrollback (model steps stay
in the status tick — they would double the tool lines). Words, not codes: "guard:
promised tools, then asked (1/2) — steering to discovery", not `guard_fired`.

**D5 · Honesty rules for the copy.** A step says what the *runtime* did or observed,
never what the model "thinks". A provider step names the platform ("Matilda
server-side search — …"), never BrainRouter. An `end` step gives the runtime's reason
in the runtime's words; when a guard's budget ended the turn, the last `guard` step
already says which and why, and the end step says "ended without an answer" or
"answered" — no inference.

**D6 · Bounded cost.** A path is at most a few dozen small records per turn; the
transcript record is one line; the desktop block renders lazily. No new knob: the
path is always on, because the runtime's interventions are always real.

## 3. What this is not

- Not a debugger or a request trace: `cli.traceRequests` / `/inspect` still hold the
  rendered prompt and tool list per request. The path is the story, not the payload.
- Not a change to any guard, budget or provider behaviour. Nothing the runtime does
  changes; what it does becomes visible.
- Not the reasoning stream. Thinking stays live-only in the "thinking…" strip; the
  path records actions and decisions.

## 4. Phases

- **P1 (this slice):** protocol event + bridge; `agent/runtime/turnPath.ts` (recorder,
  guard-status parser, renderer); emitters in the model phase, both guard sites,
  `runTurn` end; `onProviderActivity` through the native stream (Matilda: server
  tools, safety replace, early end); transcript record + row reconstruction; desktop
  `Path` block (live + reload) with tool steps interleaved; CLI notice lines; tests.
- **P2:** TUI path panel (ink) and `/path`; a per-turn "why it stopped" one-liner
  under the final answer; drill-down from a step to the request trace when
  `cli.traceRequests` is on; child-agent paths in the task view.

## 5. How this will be judged

1. Reopening the session in §1 shows, for turn 2: model call → guard (promised tools,
   then asked 1/2) → `list_dir` ✓ → `list_agents` ✓ → model call → guard (deliverable
   1/1) → model call → ended (answered) — with no code change to the guards.
2. A Matilda turn whose server-side search preempted the tools shows a `provider` step
   naming that search before the model's answer; an OpenAI turn shows none.
3. A router fallback shows as a failed `model` step naming the route it moved to,
   followed by the successful call on the new route.
4. The `turn-path` record never appears in a provider request (asserted by the
   `loadHistory` role filter).
5. The desktop and the CLI show the same steps in the same order for the same turn.

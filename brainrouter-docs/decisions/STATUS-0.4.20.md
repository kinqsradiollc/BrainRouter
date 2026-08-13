# Where the 0.4.20 decisions actually stand

One page, so the state of a release can be read without opening every decision
document and reconciling them. Each ADR's own status block is the authority; this is an index
that must agree with all of them or be wrong.

**Read the rightmost column first.** "COMPLETE" here means *every decision in the
document either reaches a person or has been explicitly retired* — not that the
code compiles and the suite is green. That distinction is the entire subject of
ADR-028, and it was earned: an audit found fifteen decisions in that ADR alone
that were built, typechecked, tested, and called by nothing a user could reach.

| ADR | Title | State | What is not closed |
|---|---|---|---|
| **028** | Surfaces that tell the truth | **SETTLED** (= complete) | Nothing. Every decision reaches a user or is retired. |
| **032** | An agent that gets better and cannot get worse | **COMPLETE IN CODE** | One acceptance run, which spends your tokens. |
| **033** | Review that finds things and says where | **PARTIAL** | One number, from a harness that ships and has never been run. |
| **034** | Messages that arrive | **COMPLETE** | Three exports nothing reaches — see below. |
| **035** | A meeting you cannot lose | **COMPLETE** | Nothing. |
| **038** | A planner worth opening | **COMPLETE** | Nothing. |
| **040** | One runtime, graphs of bounded loops | **ACCEPTED · IMPLEMENTATION ACTIVE** | A40-1 is implemented; A40-2–A40-11 remain open. |

---

## 028 — Surfaces that tell the truth · SETTLED

Two rounds resolved all fifteen unreached decisions, and the honest answer was
usually deletion rather than wiring: stacked pull requests (A2–A5, A7, A8), Part F
(F1–F6), and C1's graph engine including its Settings dropdown are **retired**.
Four were **wired**, because the export held real behaviour nothing ran — most
consequentially D11, where a pulled tombstone never tombstoned its time blocks, so
a deletion on one device left orphan blocks that `updateBlock` then refused. That
was a live data bug hiding behind an unreached export.

A third pass in this release retired the workbench control layer nothing
dispatched and the stacking advice for the system just retired: roughly 5,900
lines in total. The inert-value sweep's ceilings fell with them and are written as
**equalities**, not upper bounds, so they can only ratchet down.

## 032 — An agent that gets better and cannot get worse · COMPLETE IN CODE

The deterministic half is demonstrated rather than asserted: 82 tests, including
the §6 exercise driven through real Agents — one learns from its own repetition, a
second runs what it learned, a third cannot once it is retired.

Three gaps from the 2026-08-11 audit are closed by **withdrawal**, because building
them meant inventing product. The hosted chat gate now **refuses a procedure by
name** (`no-execution-port`) with its own counter, rather than silently downgrading
it to a lesson — a silent downgrade and an explicit refusal are different promises.

**The procedure ledger is built.** A promoted procedure now carries the exact calls
the RUNTIME watched succeed, beside the model's prose retelling of them. The
evidence was already reaching the checkpoint and was being discarded after the tool
ceiling was computed. Because it is built from runtime observations rather than
model text: a cited action the runtime never saw is dropped, the order is the
runtime's and not the model's, and a step outside the tool ceiling is dropped — so
the model can narrow the ledger and never widen it. It is reached, not merely
stored: the promoted skill renders a "What actually ran" section that `get_skill`
serves.

**Not closed:** one thing. The live-model §6 run is unrecorded. **Not blocked on
code** — providers are configured and enabled. §6 requires an *owner-approved* run,
because it spends someone's tokens, and that is not a decision an agent should
assume.

## 033 — Review that finds things and says where · PARTIAL

D1–D5, D8 and D9 are shipped **and reached** on a real user path: the bot through
the scheduler executors, the CLI `/review` handler, and the desktop host. D6 is a
stance and lives in the prompt. §6's deterministic COST conjunct passes: bundled
sends **516,672 characters in 16 calls against legacy's 545,529 in 12** — −5.29%,
down from +33,537 before.

**The harness has been RUN and it works** (2026-08-12, local `qwen2.5-coder` on
Ollama). It prepared exact-revision evidence, executed both arms of case `pr-743`
across six model calls, scored them, and wrote its artifact. That settles a
question this page could not previously answer: whether the runner would execute
at all.

**Not closed:** the number itself, and the reason is now specific. The 7B could
not produce the fenced envelope on its first call. The 14B produces it reliably,
completed `pr-743` — and found nothing: legacy 0/0, bundled 0/0, on a case
carrying curated known issues — then failed `pr-1242` on invalid findings. Zero
recall against planted defects is a capability wall, not a formatting one, so a
third local model would not help. D7 needs a frontier-class provider, and the
stored keys are sealed with `BRAINROUTER_SECRET_KEY`, so that key is the owner's
to supply.

Both failures are evidence FOR the design: each aborted the run and wrote an
explicitly FAILED artifact rather than degrading into a zero-finding report that
would have read as a clean review.

## 034 — Messages that arrive · COMPLETE

Merged as #1345 on 2026-08-12 at 13:08:58, before the rest of this release's ADR
work. Its first CI run earned its keep by catching a cross-ADR regression: a
fail-closed MCP approval broke ADR-032's §6 test, because a headless prompter
refused before retirement was ever consulted. Fixed by annotating the genuinely
read-only `get_skill` stub with `readOnlyHint`.

**It reached the D10 branch late, and that mattered.** #1345 landed on
`release/0.4.20`, but `feat/adr-035-d10-adapter` had branched 56 seconds earlier
and never pulled it in — so every green result on that branch was measured on a
tree without it. Merging the two took nine conflicts, six of them real: ADR-028
retired the `review` and `ci` panels while ADR-034 added `peers` (both correct,
either side alone wrong), and ADR-028 G5 had folded `StackPanel` into an inline
case so its import had to go. The five meetings-path conflicts were ours-is-newer
throughout — checked hunk by hunk, their side introduced no identifier ours
lacked. Combined tree: 4342 core, 544 + 648 desktop, zero failures.

**The sweep caught three unreached exports in this ADR**, which is the
built-but-unreached class 028 exists to find, found by the mechanism 028 built:

- `session/input/heldSessionMessages.ts :: rejectHeldSessionMessage`
- `session/messaging/routes.ts :: findSessionRouteByKey`
- `session/sessionTitle.ts :: resolveSessionTitle` — a second variant of
  `resolveSessionTitleDecision`, which is the one `agent.ts` actually calls

All three compile, typecheck, and are covered by tests. None is called on a user
path. `DEAD_EXPORT_CEILING` therefore rose 270 → 273 **with a comment naming all
three**, rather than absorbing the delta silently — an unexplained rise is how a
ratchet stops meaning anything. Deleting another decision's tested behaviour
inside a merge commit was deliberately not done; each needs wiring or deleting.
`rejectHeldSessionMessage` looks like a half-wired feature: messages can be held,
apparently not rejected.

## 035 — A meeting you cannot lose · COMPLETE

- **D9** — destructive acceptance **passes on both hosts by reproduction**: a real
  SIGKILL mid-recording and a real browser, reopened, losing nothing.
- **D6** — retention ships on both hosts: a named 30-day default, a control in each
  capture surface, and a sweep performing the same deletion an explicit discard
  does, refusing any capture the host says is being written to.
- **D10** — the **engine end** of the live acceptance passed on 2026-08-12 against
  the bundled sidecar with `ggml-base.en`: audio fed at microphone pace produced a
  partial 1.4s behind the speaker reading *"Dana will present the meeting"*, which
  the final revised to *"Dana will present the migration plan"* before `committed`
  advanced the checkpoint. That revision is the case the contract exists for — a
  partial is a hypothesis, only a final is a boundary, only `committed` may move a
  resume point.
- **D11** — ships as a server-side **transcript** escrow. Its audio half is
  **withdrawn**, not deferred.

- **D10 host end** — accepted 2026-08-12 via `npm run acceptance:meeting-streaming`,
  which drives the shipped chain (sidecar document → the brain's gateway probe →
  Core's strict v1 reader → `selectTranscriptionMode`). Against the live engine the
  host selects `streaming`; against an unreachable origin, a different protocol, an
  unhonourable latency mode, and an empty mode list it degrades to `segmented`.
  Mutation-checked: removing the adapter's protocol gate fails exactly one case.

- **D10 reconnect/replay** — accepted in the same run. A stream cut mid-meeting
  leaves the resume point where the engine last *committed*; visible partial text
  does not move it; replay resumes exactly one chunk past the checkpoint; coverage
  beyond the written ledger is refused rather than clamped; and a reconnecting
  endpoint cannot un-commit settled audio.

- **D10's CI job** — `meeting-streaming-acceptance` in `.github/workflows/docker.yml`
  builds the sidecar, runs it on loopback, and drives the acceptance on every PR
  touching the sidecar, the brain, or the packages. The harness exits non-zero
  rather than skipping when nothing answers, so the job cannot go green by
  testing nothing.

**Not closed:** nothing.

## 038 — A planner worth opening · COMPLETE

D1's acid test passes: a new block type or in-block keyboard shortcut is added once
and appears on both hosts. The dashboard's notes page went from 1,788 lines to 64.

The repair round mattered more than the build, because the first pass shared the
**rendering** and not the **projection**, and it had already drifted: the dashboard
could not say sync was FAILING — it said "4 changes waiting to sync" no matter how
many operations were wedged, which is §6's own criterion failing on one host. D3
closed last: the field that sorts the day can now be set from the day, through the
same outbox as every other planner write.

## 040 — One runtime, graphs of bounded loops · ACCEPTED · IMPLEMENTATION ACTIVE

The decision keeps ADR-028's deletion of the unreachable second turn engine.
There is one bounded turn engine; Core-owned policy will choose graph-shaped
orchestration around it, and CLI/Desktop will render one event-derived execution
map. The implemented A40-1 slice repairs the truth underneath that work: all 17
workspace profiles resolve exact or declared bundled plan identity without
changing their reviewed modes, and runtime state carries workspace and plan IDs
separately. A40-2–A40-11 remain open and this row makes no claim about them.

---

## What an owner has to decide

Two items are outstanding and **neither is blocked on engineering**. Both were
checked rather than assumed: no local model is serving on this machine, so
neither can be run at zero cost without you.

| Item | Needs |
|---|---|
| 032 · live-model §6 run | Approval to spend tokens on it |
| 033 · D7 precision/recall | A provider key supplied to the harness's env var |

Those are the only owner-run acceptance decisions listed here. ADR-040's remaining
A40-2–A40-11 rows are engineering work, not acceptance that can be inferred from
the decision being approved. 032's procedure action ledger — previously the one
genuinely unwritten piece of code — is built, tested and reached.

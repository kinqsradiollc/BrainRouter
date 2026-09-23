# ADR-046 — The runtime that vouches for itself: harvested catalogs, a logged-context guarantee, and a roster of invariants

**Status:** Accepted — **implemented (S1–S6)**. S6 landed the last code-defined catalog — the
model-class runtime catalog + drift gate (`release/0.4.22`, #1587): the `BrainAgentModelClass` type
now derives from a runtime `BRAIN_AGENT_MODEL_CLASSES`, and the generated `model-class-catalog.md` is
harvested from it × the live brain-agent registry. Personas and file-based triggers are deliberately
NOT catalogued: they are runtime/user-defined sets, not code-defined ones, so a "generated from code"
catalog would be misleading for them. The foundational spine, both
drift-gate classes, the shared derivation, and the glass-box surface are live in `packages/core`,
`brainrouter`, and `brainrouter-dashboard`, with tests as the CI runner.

**Design correction during implementation:** D3 does NOT introduce a new roster. Core already ships
the **A41-14 runtime-invariants registry** (`packages/core/src/runtime/invariants.ts` — per-area
"companions" of pure checks, a `verifyInvariants()` gate, and glass-box wiring via
`runtimeCompositionSnapshot()`). Shipping a parallel registry would violate "one home per fact", so
ADR-046 **extends A41-14** instead: it registers new companions and adds the one thing A41-14 lacked
— a **push/tripwire channel** for repairs that already happened. **S1/D3:** the built-in check
`tool-capabilities/every-tool-has-exactly-one-capability` (reads the live tool/capability
registries) and an empty, attributed `session-history` companion are registered through the existing
`registerBuiltinInvariantCompanions()` baseline (the real, non-test consumer called by the
composition snapshot). **S1 tail / D2 tripwire:** `runtime/invariantReports.ts` is the new push
channel (`noteRuntimeInvariantBreak` + per-id totals); `sanitizeToolCallPairing` gained an optional
pure `PairingRepairObserver`, and both hot-path callers (`session.impl.ts` load-replay,
`modelInvocationPhase.ts` pre-dispatch) wire it via `reportPairingRepair`, so every pairing repair
is a counted tripwire, surfaced in the composition snapshot's `invariants.runtimeReports` (advisory,
deliberately outside the pull-model verify gate so it cannot depend on test order).
**S2 (D1 catalogs):** two harvested, byte-drift-gated docs — `command-catalog.md` (from
`SLASH_COMMANDS` + `HELP_CATEGORIES`, also flagging any undocumented command) and
`capability-catalog.md` (from `CAPABILITY_TOOLS`), on the A41-16 template, regen via `REGEN_CATALOG=1`.
**S3 (D1 SQL case):** `brainrouter/src/__tests__/sql-enum-drift.test.ts` harvests a migration CHECK
constraint's value set from SQL text and asserts identity with the exported TS `as const` array;
seeded with the flagship `session_inbox.status ↔ SESSION_MESSAGE_STATUSES` pair and an extensible
`PAIRS` registry (each gate proves it can catch an injected divergence). **S4 (D2 shared
derivation):** `deriveModelRequest` is the SINGLE history→model-request projection, called by both
the live path and resume; `model-request-derivation.test.ts` asserts it is a fixed point, that
resume reproduces byte-identical context, and — reading source — that neither hot-path file derives
any other way (no direct `sanitizeToolCallPairing`), so the two paths cannot silently fork. The
report side is the tripwire; the structural guarantee is the shared function + this test.
**S5 (throwing + glass box):** the built-in companions run in CI via the A41-14 verify-gate test
(a failing check fails the build — D2/D3's dev/CI enforcement), and the dashboard runtime ("glass
box") panel now renders the tripwire totals — a "Tripwire firings" metric + a per-id breakdown that
should read zero. **S6 (done, #1587):** the model-class runtime catalog + drift gate — the last code-defined set that
was still a type-only union. Personas and file-based triggers are deliberately not catalogued: they
are dynamic (runtime/user-defined), not code-defined registry sets, so they are not D1-shaped and a
generated-from-code catalog would mislead. Historical proposal follows.

**Builds on:** ADR-041 (plug-and-play runtime: registries, phase hooks, the D4 logged-invariant
fence, the A41-16 tool catalog), ADR-040 (bounded loops), the glass-box trajectory surfaces
(0.4.21 D14).

**Date:** 2026-08-23

---

## 0. The decision in one page

Three recurring bug classes in 0.4.20–0.4.21 share one root: **the platform describes itself in
prose that nothing forces to stay true.**

1. **Catalog drift.** Hand-maintained inventories of generated things go stale the moment the
   source changes. We already hit this hard enough to build the fix once: the tool catalog is now
   *harvested* from the registry and drift-gated in CI (ADR-041 A41-16). But tools are one registry
   among many — commands, providers/model classes, extension capabilities, personas, trigger rules,
   and SQL enum columns all have the same shape and none of them have the same gate. The SQL
   CHECK-constraint ↔ TS-union drift (in-memory test stores enforce no CHECK, so migration enums
   silently diverge from exported unions) is the same bug wearing a different coat.
2. **Repaired context instead of guaranteed context.** The CLI keeps model history valid by
   *sanitizing* it after the fact: `toolCallRecovery.ts` detects orphaned `tool_calls` and injects
   synthetic placeholder results so strict validators don't reject the next request. A sanitizer
   means the invariant was already violated upstream and we are patching the symptom at the last
   exit. ADR-041 D4 stated the right rule for one narrow case — a phase hook may not mutate the
   in-flight request array; model-visible context enters via history, "or fork/resume/replay would
   lie" — and enforces it with a snapshot fence. That rule deserves to be the platform-wide law,
   not a hook-local fence.
3. **Scattered assertions.** Core + server contain ~44 ad-hoc invariant-style throws, each written
   where a bug once lived, none discoverable, none runnable as a set, none owned. When a subsystem's
   assumptions break, we find out wherever the next symptom surfaces — not from the subsystem
   saying so itself.

The decision:

> **Make self-description mechanical in three moves. (D1) Every registry-shaped surface gets a
> harvested, drift-gated catalog: the doc is generated by booting the registry and CI fails when
> the committed artifact disagrees with the harvest — the A41-16 pattern promoted from one
> instance to the house rule. (D2) Adopt "model-visible means recorded" as a stated platform
> invariant: everything that reaches a model request must be derivable from durably recorded
> session state, asserted at the model-invocation boundary — turning the pairing sanitizer from
> the mechanism into a tripwire that should never fire. (D3) Give invariants a roster: a
> lightweight registry where each subsystem registers named runtime checks against its own
> authoritative state, runnable as a set in CI, at boot in dev, and on demand from the glass
> box.**

---

## 1. Where the code is today

| Piece | Current shape | Consequence |
|---|---|---|
| Tool catalog | `brainrouter-docs/generated/tool-catalog.md`, harvested from `packages/core/src/extension/builtin/{toolSpecs,toolCatalog}.ts`; drift-gated by `packages/core/src/tests/tool-catalog-drift.test.ts`; regenerated via `REGEN_CATALOG=1` (A41-16) | The pattern exists, works, and caught real drift during the 0.4.21 D14 program (the REGEN lesson: a merged PR changed specs without regenerating; the gate is what surfaced it). It covers exactly one registry. |
| Other registries | Commands (`command/catalog.ts`), extension capabilities (`extension/registry.ts`), personas (`workspace/personaRegistry.ts`), trigger rules (`triggers/rules.ts`), selection catalog (`workspace/selectionCatalog/`), provider/model classes | No harvested artifact, no drift gate. Inventories live in prose (rules files, ADRs, README tables) that nothing checks. |
| SQL enums vs TS unions | Migration CHECK constraints and exported TS unions are maintained by hand in parallel; in-memory test stores enforce no CHECK | Divergence is invisible until a real Postgres rejects a row CI accepted. Same drift class, storage-shaped. |
| Model-history integrity | `packages/core/src/agent/guards/toolCallRecovery.ts` — pure helpers that de-duplicate `tool_calls` ids and inject synthetic placeholder results for orphans, applied when history is (re)assembled | Repair, not guarantee: the sanitizer exists *because* history can go invalid. Strict upstream validators (400s on unpaired calls) made this urgent; resume/compaction made it recurring. |
| The D4 fence | `packages/core/src/agent/runtime/modelInvocationPhase.ts` — snapshot-compares the request array around provider-call phase hooks; throws "logged-invariant violation" on mutation | The right law, enforced for one mutator (hooks) at one boundary. Nothing asserts the broader claim that assembled history ≡ what the recorded session state derives. |
| Runtime assertions | ~44 `throw new Error('invariant…')`-style checks scattered across `packages/core/src` and `brainrouter/src` | Each guards one scar. No enumeration, no way to run "all invariants" after a change, no ownership, no surface where their status is visible. |
| Glass box | 0.4.21 D14 trajectory/decision surfaces on desktop + dashboard | A natural read-side home for invariant status that currently has nothing systematic to display. |

---

## 2. Options considered

| Option | Verdict | Why |
|---|---|---|
| A. Keep prose inventories, review harder | **Rejected** | We ran this experiment for two releases; the D14 REGEN lesson and the SQL-union drift are its results. Review does not scale to N registries × M PRs. |
| B. Generate docs at build time, don't commit them | **Rejected** | An artifact that only exists in CI can't be read in the repo, diffed in a PR, or cited by rules files. Committing the artifact and gating the diff makes drift a *visible reviewable change* instead of an invisible absence. |
| C. Harvest + committed artifact + drift gate (A41-16 pattern) | **Adopted (D1)** | Already proven in-repo on the hardest registry (87 tools). Cost per additional registry is one harvest function + one test. |
| D. Keep the sanitizer as the mechanism | **Rejected as end-state; kept as tripwire** | A sanitizer that silently fixes history hides the upstream bug forever. Keeping it as a loud last-resort (log + counter + invariant report) preserves the safety net while making violations visible. |
| E. Big-bang event-sourcing rewrite of session state | **Rejected** | The guarantee we need — "model-visible derives from recorded state" — does not require re-architecting storage. Assert the derivation at the boundary; let construction converge on it incrementally. |
| F. Central invariant framework with scheduling, severities, dashboards | **Rejected as scope** | A registry + a runner is enough. Anything more is speculative machinery; the glass box already provides the display surface. |

---

## 3. Decisions

### D1 — Catalogs are harvested, committed, and drift-gated; prose never inventories a registry

- **The rule:** any surface that is registry-shaped — a finite, code-defined set of named things
  with metadata (tools, commands, capabilities, personas, trigger rules, provider/model classes,
  SQL enum ↔ TS union pairs) — gets a generated artifact under `brainrouter-docs/generated/`,
  produced by *executing* the registry (boot/harvest, not source-scraping), committed to the repo,
  and covered by a drift test that fails when regeneration changes the artifact.
- **One regeneration convention:** the existing `REGEN_CATALOG=1 npm --workspace <ws> test --
  <drift-test>` flow is the template; each catalog documents its own regen line in the artifact
  header exactly as `tool-catalog.md` does today.
- **The SQL case:** for each enum-bearing column, a harvest emits the CHECK constraint's value set
  from the migration source and the exported TS union's member set, and the drift test asserts they
  are identical. This closes the in-memory-store blind spot without needing Postgres in unit CI.
- **Priority order:** commands, extension capabilities, SQL enums (the three with recorded
  incidents or near-misses), then personas/triggers/model classes opportunistically.
- **Docs rule:** rules files and ADRs *link* catalogs; they do not restate their contents. A PR
  that changes a registry carries the regenerated artifact in the same diff — which is also what
  makes the change reviewable at a glance.

### D2 — "Model-visible means recorded" is a platform invariant, not a hook rule

- **The statement:** anything that reaches a model request — messages, tool schemas, injected
  context — must be derivable from durably recorded session state (history, transcript,
  trajectory). If it isn't recorded, it doesn't go to the model; if it went to the model, resume,
  fork, replay, and the glass box can all reproduce it.
- **Enforcement point:** the model-invocation boundary (`modelInvocationPhase.ts`), generalizing
  the existing D4 fence: before dispatch, assert that the assembled request equals the projection
  of recorded state (same derivation the resume path uses). One derivation function, used by both
  the live path and resume, is the mechanism — the assertion is then structural equality, and
  "live context" can never silently diverge from "resumed context" again.
- **The sanitizer becomes a tripwire:** `toolCallRecovery.ts` keeps running (production must not
  400), but any repair it performs is now an invariant violation report — logged with the shape of
  the orphan and surfaced via D3 — instead of a silent fix. The target steady state is a sanitizer
  that never fires; every firing is a bug with a paper trail.
- **Rollout:** assert-and-report first (violations logged, not thrown) for one release; promote to
  throwing in dev/CI once the report stream is quiet; production keeps report-only.

### D3 — Invariants get a roster: registered, named, runnable as a set

- **The primitive:** `registerInvariant({ id, area, check })` in core, where `check` inspects the
  subsystem's *authoritative state* (stores, live registries, event streams) and returns ok /
  violation-with-detail. Registration lives next to the subsystem it describes; the registry is
  just an enumeration.
- **Three run surfaces:** (1) a CI test that runs every registered invariant against the seeded
  test environment; (2) a dev-boot pass that runs them once after startup and logs violations;
  (3) an on-demand run surfaced in the glass box / doctor output, so "is this install healthy?"
  has a mechanical answer.
- **Migration, not big-bang:** the ~44 existing scattered assertions stay where they are; new
  invariants and D2's tripwire reports go through the roster from day one, and existing ones move
  opportunistically when their file is next touched. An area with no registered invariant is
  allowed — but the roster makes that visible instead of unknowable.
- **What a check may not do:** no network, no mutation, no LLM calls. Invariants are cheap, local,
  and deterministic, or they don't belong in the roster.

---

## 4. What this deliberately does not do

- **No new frameworks.** D1 is a pattern promotion (the generator/gate pair already exists), D2 is
  one derivation function plus one assertion, D3 is a registry and a for-loop. No scheduler, no
  severity taxonomy, no invariant DSL.
- **No storage rewrite.** D2 asserts derivability at the boundary; it does not mandate
  event-sourced persistence. If construction later converges on append-only session events, the
  assertion is how we'll know it's safe.
- **No production throwing.** Violations in production report; only dev/CI escalate to failure.
  The platform's first duty is to keep working; the invariant's duty is to make sure we *know*.
- **No retroactive catalog for every enumerable thing.** Registry-shaped and incident-adjacent
  first; a catalog nobody reads is drift of a different kind.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Drift gates become regen-noise ("test fails, run the magic env var, move on") | The artifact diff is in the PR — reviewers see *what* changed, which is the point. If a gate produces regen churn without ever catching a real divergence after two releases, delete that catalog. |
| D2's equality assertion is too strict (legitimate non-recorded ephemera exist) | The derivation function is the single place exceptions are declared — an allowlisted ephemeral field is explicit and reviewed, not ambient. |
| Invariant checks rot into always-green trivia | Each check must fail in a test that breaks its subsystem's state (the drift tests already follow this discipline: the test proves the gate can catch the bug it exists for). |
| Roster runs slow CI | Checks are local and deterministic by rule (§3 D3); the CI pass budget is seconds, enforced by the same test that runs them. |

---

## 6. Implementation slices

| Slice | Contents | Size | Status |
|---|---|---|---|
| S1 | D3 roster (extend A41-14, not a new one) + the tripwire push channel | S | ✅ done — companions `tool-capabilities` + `session-history` via `registerBuiltinInvariantCompanions()`; `runtime/invariantReports.ts` push channel wired at both hot-path callers |
| S2 | D1 command catalog + extension-capability catalog (harvest + gate, A41-16 template) | S | ✅ done (`command-catalog.md`, `capability-catalog.md` + drift tests) |
| S3 | D1 SQL enum ↔ TS union harvest + gate | M | ✅ done (`sql-enum-drift.test.ts`, flagship `SESSION_MESSAGE_STATUSES` pair, extensible `PAIRS`) |
| S4 | D2 shared derivation function used by live + resume | M | ✅ done (`deriveModelRequest`; fixed-point + live/resume-equality + no-private-copy tests) |
| S5 | D2 CI enforcement (verify gate) + glass-box tripwire panel | S | ✅ done (A41-14 verify-gate test fails the build on a broken check; dashboard runtime panel renders tripwire totals) |
| S6 | Remaining catalogs | S each | ✅ done (#1587 — model-class runtime catalog + drift gate; `BrainAgentModelClass` derives from `BRAIN_AGENT_MODEL_CLASSES`. Personas/file-triggers intentionally left dynamic — runtime/user-defined, not code-defined) |

Each slice is independently shippable and independently revertible; S1 extended the existing A41-14
registry (one home per fact) rather than adding a parallel roster.

---

## 7. Acceptance

- A PR that changes any cataloged registry without regenerating its artifact **fails CI**, and the
  failure message names the regen command.
- The SQL gate fails when a migration CHECK and its TS union diverge — proven by a test that
  introduces a deliberate divergence.
- Resume/fork of a session reproduces byte-identical model-visible context to the live turn that
  produced it, asserted by the shared derivation function in CI.
- `toolCallRecovery` repairs appear as invariant reports with orphan detail; a release-over-release
  count is visible in the glass box.
- `runInvariants()` (CI, dev boot, glass box) enumerates every registered check with pass/fail and
  detail; breaking a subsystem's state in a test flips its invariant red.

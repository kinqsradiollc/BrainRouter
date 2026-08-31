# ADR-052 — Resilient turns, attributed spend, and a restricted seat

**Status:** IMPLEMENTED (0.4.22) — nine phases built and merged (P1a #1631, P1c #1628, P2a #1632,
P2b #1633, P2c #1627, P3-core #1626, P4.2 #1635, P4.3 #1630, P4.5 #1634); three were already satisfied
in-tree (P1b, P4.1, P4.4 — see §4); P3 project-config-ignore (#1637) and P4.6 (via ADR-053, #1638) since landed; P4.7 is already in-tree.
The ONLY remaining slice is the P2a/P2b **dashboard admin UI** (the core + CLI data is built; surfacing it
as a brain-server API + dashboard panel needs the live dashboard/server to build and verify). · **Builds on:** ADR-041 (token-meter extension,
registry discipline), ADR-046 (surfaces that vouch for themselves), the safeMode/fallback work
(#796), and the org-settings KV pattern (per-org recall settings). · **Informed by:** a study of
contemporary agent-harness release notes (2026-08-20 → 2026-08-28); no external project is named
or copied — every decision below is grounded in our own code and its already-known gaps. ·
**Related:** ADR-051 (notebooks — reviewed separately); the file-tool security audit runs as
ordinary fix PRs, not an ADR.

**Date:** 2026-08-30

> Three gaps keep showing up at the seams of real sessions. A turn that dies mid-stream on a
> flaky gateway is a *lost* turn, even though we already classify the error as retryable. A month
> of fleet jobs, loops, and sub-agents shows up as one undifferentiated token number, so a runaway
> automation looks identical to honest work. And the only lockdown we ship is `safeMode` —
> all-or-nothing — when what an untrusted repo or a CI seat needs is a *restricted* profile:
> tools jailed, project config ignored, escalation refused. This ADR closes those three, plus a
> short list of small parities each of which is already a known sore spot in our own tracker.

---

## 1. Where the code is today

- **Retry classification exists; stream resumption does not.** `agent/transport/llmTransport.ts`
  already classifies retryable server errors (5xx, masked 400s, 429s) and the gateway retry was
  hardened this cycle — but a response cut off MID-STREAM in a headless or server path still
  fails the whole turn: the partial text is discarded and the caller sees an error, not a
  continuation.
- **A malformed tool call poisons its own retry.** When the model emits a broken tool call, the
  retry re-sends the conversation as-is — broken output included — so the retry is anchored to
  the same failure. We already own the precedent for context hygiene
  (`sanitizeToolCallPairing` keeps history pairing strict); the retry path never got it.
- **A capped delegate looks finished.** A delegated agent (`orchestration/tools/spawn.ts`,
  `orchestration/agents/agentTools.ts`) that stops at its turn budget returns whatever it has,
  indistinguishable from a completed result — the parent synthesizes over an answer that quietly
  ran out of turns.
- **The meter counts the session, not the automation.** The token-meter extension (A41-13,
  `tests/token-meter-extension.test.ts`) meters usage, but a loop, a fleet job, and a sub-agent
  all pour into one bucket; nothing answers "which automation is eating the budget?" — the exact
  question a runaway loop raises.
- **Cost surfaces assume list price.** Orgs with contracted rates read meter figures that are
  wrong for them; we already have the pattern for org-scoped operational settings
  (`system_settings` KV behind `/api/admin/recall-settings`) — pricing never joined it.
- **Effort is per-session, not per-model.** `resolveEffort` (`config/config.ts`) resolves one
  effort for the session; switching models drops the level you'd tuned for the previous one.
- **`safeMode` is a circuit breaker, not a profile.** `cli.safeMode`
  (`config/configTypes.ts:785`) skips loading whole subsystems (`:358`, `:1098`) — right for
  "get me a working session", wrong for "run in this untrusted repo": there is no mode that keeps
  the agent useful while removing exec/web tools, jailing file tools, and ignoring
  project-supplied config.
- **Known small gaps, already on file:** the goal banner sticks at WORKING
  (`desktop/src/lib/agent/useAgentEvents/handleQueryResult.ts` — the continuation query never
  refreshes); desktop session messaging has durable sender receipts
  (`electron/host/sessionMessaging.ts:66,404`) but a refused or dropped message is not clearly
  reported back to the sender, and there is no one-shot "tell me when that session goes idle";
  the hooks catalog (`hooks/service.ts`, `hooksStore.ts`) has no model-switch events; model
  pickers are endpoint-driven (`GET /models` — by rule, never hardcoded) but an org cannot
  curate ordering or labels; `MarketplaceSource` (`configTypes.ts:316`) has no way to
  authenticate against a private catalog without a static secret; the CLI TUI appends progress
  ticks instead of replacing them.

---

## 2. Decisions

**D1 · Turns that survive the wire.** (a) In headless/server paths, a response cut mid-stream by
a server error, connection loss, or stall is **continued, not failed**: the transport retains the
partial text and reissues the request as a continuation, bounded by the existing retry budget.
(b) On a malformed-tool-call retry, the broken output is **dropped from the retry context** (the
`sanitizeToolCallPairing` discipline applied to retries). (c) A delegated agent that stops at its
turn budget returns its output **marked partial**, with the resume affordance named, so the
parent can continue it instead of trusting it. *Acceptance: a killed stream mid-answer produces a
complete answer on the same turn; a capped sub-agent is never mistaken for a finished one.*

**D2 · Spend you can attribute.** Token usage carries an **automation attribution** (loop id,
fleet-job id, sub-agent spawn, interactive) through the meter into the dashboard: per-automation
totals, per-run averages, last-run stamps. An **org pricing table** (dashboard-admin, the
`system_settings` KV pattern) supplies contracted per-model rates and a discount multiplier to
every cost surface. **Per-model effort defaults** persist in `cli.*`: each model keeps its tuned
level across switches. *Acceptance: a runaway loop is identifiable by name in one view, and an
org's cost figures use its real rates.*

**D3 · A restricted seat.** A `cli.restricted` profile — composable with, not replacing,
`safeMode`: removes exec/terminal/web tools from the builtin set, jails file tools to the
workspace root, **ignores project-supplied configuration** (workspace profiles, project hooks,
project-declared servers), and refuses full-access/auto-edit posture escalation. For untrusted
repos, CI seats, and reviewer runs. Surfaced as a launch flag and a Settings toggle, and stamped
on the session so surfaces can say *why* a tool is absent (ADR-046 honesty). *Acceptance: in a
restricted session an exec attempt names the profile as the reason, and a project hook never
fires.*

**D4 · Small parities, each PR-sized, priority-ordered.** (1) Goal check-ins on long-running
background work **back off** (30m → 1h → 2h) — and the stuck-WORKING banner bug is fixed in the
same slice. (2) Session messaging reports **refusals and drops to the sender** (no silent loss)
and gains a one-shot **notify-when-idle**. (3) Hook events for **model switch** (pre/post) and
**resume staleness**. (4) A built-in **concise output style** knob layered under personas.
(5) **Org-curated model-picker overlay** — ordering, labels, pinning — applied OVER the
`GET /models` result (the endpoint stays the source of truth). (6) `MarketplaceSource` gains an
**auth helper** whose secret lives in Settings (write-only, stripped from snapshots — the
existing secrets rule). (7) The CLI TUI **replaces** per-second progress ticks instead of
appending them. *Acceptance: each lands (or is explicitly dropped) as its own PR row.*

---

## 3. What this is not

- **Not an approval classifier.** An LLM- or rule-scored auto-approval mode is a large trust
  decision — its own ADR if ever wanted; D3 is subtractive (fewer tools), never permissive.
- **Not spend enforcement.** D2 is attribution and truthful pricing; budgets/limits that *stop*
  work would build on it as a separate decision.
- **Not the notebook work.** ADR-051 stands alone.
- **Not a fixed model catalog.** D4's picker overlay curates presentation of the live endpoint
  result; the "models from `/models`, never hardcoded" rule is load-bearing and unchanged.
- **Not the security audit.** The file-tool audit (symlink TOCTOU, deny-rule edges, guard
  bypasses) runs as ordinary fix PRs on its own track; findings need fixes, not decisions.

---

## 4. Dependency-ordered delivery board

Rows are independent unless noted; each is one PR.

- **P1a — Stream continuation** (D1a) — ✅ #1631: `streamContinuation.ts` continue-on-cut for the
  headless/server model path, bounded by the retry budget; tests fake a mid-stream cut.
- **P1b — Retry context hygiene** (D1b) — ✅ already in-tree: a malformed tool call already returns a
  structured `isError` tool_result (with the raw args echoed) so the model self-corrects next turn.
- **P1c — Partial-marked delegates** (D1c) — ✅ #1628: a turn-budget stop is marked partial + carries
  a resume hint (`completionPhase.ts`).
- **P2a — Automation attribution** (D2) — ✅ core #1632 (attribution through the usage meter +
  `usageHistoryStore`). Remaining: the dashboard per-automation VIEW (brain-server API + panel) — needs
  the live dashboard to build/verify.
- **P2b — Org pricing table** (D2) — ✅ core #1633 (contracted-discount multiplier on the CLI cost
  surfaces). Remaining: the `system_settings` admin UI (brain-server API + dashboard panel, the
  `AdvancedRecallPanel` pattern) — needs the live dashboard to build/verify.
- **P2c — Per-model effort defaults** (D2) — ✅ #1627: `cli.effortByModel` resolved model→effort.
- **P3 — Restricted profile** (D3) — ✅ core #1626 (read-tier clamp, no-network, no-escalation,
  session stamp); the project-config-ignore slice + desktop toggle are follow-ups.
- **P4.1 — Goal check-in backoff / banner** — ✅ already in-tree (the desktop goal banner refreshes
  on a terminal action; check-in backoff is the existing behaviour).
- **P4.2 — Messaging refusal reporting + notify-when-idle** — ✅ #1635 (`notify_when_idle` one-shot).
- **P4.3 — Model-switch hook events** — ✅ #1630 (pre/post model-switch hook events).
- **P4.4 — Concise output style** — ✅ already in-tree (`personality: 'concise'` with the
  `cli.personalityDefault` knob).
- **P4.5 — Org-curated picker overlay** — ✅ #1634 (`cli.modelPicker` overlays the `/models` result).
- **P4.6 — Marketplace auth helper** — ✅ built on ADR-053: the HTTP marketplace fetch (ADR-053 P1)
  carries a `headersHelper` that mints request headers (secret in Settings) for a private catalog.
- **P4.7 — TUI progress-tick collapse** — ✅ already in-tree: the CLI's `child-fleet` progress row
  updates IN PLACE via a pinned stable id (`useScrollbackState.ts` — "Existing row → update in place"),
  so per-second ticks never pile up in the transcript.

---

## 5. How this will be judged

1. A mid-stream gateway cut during a headless run yields a complete answer, not a failed turn.
2. A sub-agent that ran out of turns is visibly partial in the parent's transcript.
3. The dashboard names the automation behind any token spike, priced at the org's real rates.
4. A restricted session cannot exec, browse, or load project config — and says so when asked.
5. Every D4 row is either merged or explicitly declined on the board — none silently dropped.

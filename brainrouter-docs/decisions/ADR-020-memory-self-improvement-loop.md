# ADR-020 — Memory Self-Improvement Loop: Skill Reliability, Autonomous Consolidation, Structured Reflection & Confidence Promotion

**Status:** Accepted (implemented; phased) · **All four phases P0–P3 shipped** on
`feat/memory-self-improvement-adr020` (migrations 041–042; skill-reliability, structured
session reflection, durable promotion tier, and the opt-in consolidation cycle). · **Extends** ADR-007 (Postgres memory store),
ADR-012 (providers DB-only), ADR-010 (tenancy) · **Builds on** the recall pipeline (`brainrouter/src/memory/recall.ts`),
`memoryEngine` (`brainrouter/src/memory/engine.ts`), the sweepers (`memory/engine/sweepersOps.ts`), and the
skill-memory tools (`brainrouter/src/tools/skills/memory/*`).

## Date
2026-07-20

## Context — we capture and recall, but the memory does not yet *improve itself*

BrainRouter already leads on **retrieval**: a four-stage recall pipeline (keyword/vector/filepath → reranker →
optional LLM relevance judge → graph expansion), pgvector embeddings, per-memory confidence with
reinforce/corroborate, churn-based decay, code-anchor governance, and multi-tenant partitioning. That is the
strong half of a memory system — *finding the right thing*.

The weaker half is the **feedback loop that makes memory better over time without a human or an agent explicitly
asking**. A review of the gaps surfaced four missing mechanics, all of which turn a passive store into a
self-improving one:

1. **No skill-reliability signal.** We can distill a skill from a session (`memory_extract_skill`) and register
   skill hints (`autoScanSkillHints`), but once a skill exists we never learn whether it *works*. There is no
   `usageCount`, no `successRate`, and therefore no way to rank reliable skills above flaky ones or to demote a
   skill that keeps failing. Skills are authored artifacts, not learned-and-graded capabilities.

2. **Maintenance is a set of parts, not an autonomous cycle.** We have sweepers, churn-decay, contradiction/dedup
   in the cognitive pipeline, and a `memory-governance` tool that archives confirmed-dead code-anchored memories —
   but these are triggered piecemeal (boot, tool call, write path). There is no single scheduled cycle that, on
   its own cadence, deduplicates, compresses aging records, promotes proven ones, and archives stale ones. The
   store does not "tidy itself."

3. **Reflection is per-turn and unstructured.** Cognitive extraction runs per turn and Core Identity is distilled,
   but we never do a **session-level** pass that names *mistakes*, *lessons*, *anti-patterns*, and *preferences* as
   first-class, retrievable records. The most valuable "what did we learn" signal is diffused across raw turn
   memories instead of being crystallized.

4. **Confidence has no lifecycle tier.** Confidence is set, reinforced, and decayed, but a memory never graduates:
   there is no promotion of high-confidence, corroborated knowledge into a durable, preferentially-recalled tier,
   and no age-based compaction of long-lived low-signal records.

Individually these are small. Together they are the difference between a memory that *stores* and a memory that
*learns*. This ADR commits to closing them as one coherent **self-improvement loop**, reusing our existing spine
rather than adding a parallel system.

## Decision

Add a self-improvement loop over the existing memory engine, in four parts. Every part is org/session-partitioned
(ADR-010), Postgres-backed (ADR-007), and additive — no change to the recall contract or the write path's
latency budget ([[project_memory_pipeline_nonblocking]] stays intact: cognition remains deferred/non-blocking).

### D1 — Skill reliability lifecycle

Give every stored skill a runtime reputation.

- Extend the skill record (procedural memory) with `usageCount`, `successCount`, and a derived `successRate`, plus
  `lastUsedAt` and `demoted` flag.
- A skill is **invoked** when its hints are injected into a briefing/recall and the resulting turn is accepted; it
  is **scored** by the turn outcome signal we already emit (turn-complete vs turn-error, and — where available —
  an explicit `memory_extract_skill` re-confirmation). Success/failure updates the counters.
- Recall ranking multiplies a skill's base score by a reliability factor; skills below a floor (e.g. `successRate <
  0.4` after N≥5 uses) are **demoted** — hidden from default injection, kept for audit, recoverable.
- New tool surface: skills expose their reputation; a `list_skills`-equivalent returns them ranked by reliability.

### D2 — Autonomous consolidation cycle ("the janitor")

Unify the scattered maintenance parts into **one scheduled, per-tenant cycle** with a configurable interval
(default 15 min; off by default in tests). Each pass, in order:

1. **Deduplicate** near-identical memories (existing contradiction/dedup logic), keeping the highest-confidence
   survivor and merging corroborations.
2. **Compress** aging low-signal records (older than a window, low confidence, never re-cited) into summaries.
3. **Promote** high-confidence, corroborated records into the durable tier (D4).
4. **Archive** stale records (recoverable expiry, never hard delete — mirrors `memory-governance`).

Implemented as a new scheduled runner alongside `sweepersOps`, gated by the same org-recall settings surface we
already expose ([[project_org_recall_settings]]), so an admin can tune or disable it per org from the dashboard.
It reuses existing primitives; it does **not** introduce a second memory model.

### D3 — Structured session reflection

On session idle (we already track active sessions and idle sweeps), run one bounded LLM pass that extracts a
typed **reflection record**: `mistakes`, `lessons`, `antiPatterns`, `decisions`, `preferences`, `reusableWorkflows`.
Each element is written as its own first-class memory, tagged `reflection`, linked back to the session and to the
turns that produced it (graph edges the recall graph-expansion stage already traverses). This runs through the
existing LLM-JSON extraction chokepoint ([[project_llm_json_extraction_chokepoint]]) and the redaction/length
chokepoint, and is **non-blocking** (deferred like all cognition).

### D4 — Confidence promotion & compaction tier

Introduce an explicit lifecycle on top of the confidence score:

- **Promotion:** a record that reaches high confidence (≥ configurable threshold, default 0.95) *and* has ≥K
  corroborations is marked `durable` — preferentially recalled, exempt from age-based decay, surfaced first in the
  reranker.
- **Compaction:** long-lived records that never promote and are rarely re-cited are compressed by D2 rather than
  kept verbatim.
- Thresholds live in the org-recall settings KV (no new `BRAINROUTER_*` env vars — [[feedback_cli_knobs_in_config_json]]).

## Scope / phasing

- **P0 — D1 (skill reliability).** Highest ROI, smallest surface: schema columns + scoring on turn outcome +
  reliability-weighted recall + a ranked skill listing. No new background process.
- **P1 — D3 (structured reflection).** Reuses the idle-sweep + cognition path; adds one typed extractor.
- **P2 — D2 (consolidation cycle).** The scheduled runner that unifies dedup/compress/promote/archive.
- **P3 — D4 (promotion tier).** Depends on D2's promote step; adds the `durable` tier + reranker exemption.

Each phase is independently shippable and independently reversible (feature-flagged per org).

## Consequences

- **Positive:** skills stop being static; the store self-maintains; "what we learned" becomes queryable; proven
  knowledge is recalled first. The system gets more useful the longer it is used — without human curation.
- **Cost / risk:** the consolidation cycle is a new periodic workload (bounded, per-tenant, off in tests); a
  mis-tuned promotion threshold could over-privilege stale knowledge (mitigated by decay still applying until
  promotion, and by the recoverable-archival invariant — nothing is hard-deleted); reflection adds one bounded
  LLM call per idle session (deferred, budgeted, chokepoint-guarded).
- **Non-goals:** no change to the recall API contract; no second memory store; no synchronous cost on the write
  path; no cross-org memory sharing (out of scope, tenancy-sensitive).

## Alternatives considered

- **Do nothing / keep manual governance.** Rejected: the value of the four mechanics compounds precisely because
  they run *without* being asked; leaving them agent-triggered means they rarely run.
- **A separate local-first SQLite memory plugin.** Rejected: we already have a superior retrieval spine (vector +
  reranker + judge + graph) and multi-tenant Postgres; forking a second, weaker store would fragment the system.
- **One monolithic "background brain" service.** Rejected for now: the four mechanics reuse existing primitives and
  fit as additive runners; a dedicated service can come later if load warrants (revisit under ADR-011 microservices).

## Open questions (please confirm on approval)

1. **Skill scoring signal (D1):** is turn-complete/turn-error a strong enough success signal, or do we require an
   explicit post-hoc confirmation before crediting a skill?
2. **Consolidation cadence (D2):** default interval (15 min?) and whether it runs on the hosted brain only vs also
   the local/loopback brain.
3. **Promotion threshold (D4):** 0.95 + K corroborations — is K=2 right, and should promotion ever expire?
4. **Reflection scope (D3):** per-session only, or also a periodic cross-session aggregation (a "what have I learned
   lately" digest)?

## Follow-ups — all addressed

The three items originally deferred are now closed, so nothing in this ADR is outstanding:

- **Reranker "recall-first" for durable** — satisfied by the existing decay mechanism: promotion sets
  `half_life_days = NULL`, and `halfLifeDecay(_, null) === 1`, so durable records never decay while others do →
  they are preferentially recalled over time. No hot-path change needed.
- **Org-recall-KV tunable thresholds** — `promotionConfidence` + `promotionMinCorroborations` are now
  first-class recall-settings fields (dashboard → Intelligence → Advanced, validated/clamped like the rest).
  `promoteDurableMemories()` resolves them from the system org's settings, falling back to the code defaults.
- **Auto-idle reflection trigger** — satisfied by the client session-end hook that already drives
  `memory_extract_skill`: the client calls `memory_reflect_session` with the session summary at end/idle. A
  server-side idle LLM loop was rejected — it would need session-summary plumbing the client already provides.

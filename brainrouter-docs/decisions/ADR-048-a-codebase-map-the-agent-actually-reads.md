# ADR-048 — A codebase map the agent actually reads

**Status:** Accepted — owner-commissioned (2026-08-25); **implemented (S1–S6)** on `release/0.4.22`. The map is now consumed by deterministic taps in the turn runtime (D1) — orientation once per session, coverage-gated retrieval each matching prompt, edit blast radius into the next turn, background refresh on drift — plus the completed session hook pair and the `atlas_context` tool.

**Depends on:** ADR-041 (plug-and-play runtime — the hook registries and phase seams this rides),
ADR-032 (learning checkpoints already anchor the session-end moment), ADR-021 (workspace
onboarding), the Atlas subsystem (0.4.16, `packages/core/src/atlas/`).

---

## 1. Where we are

Since 0.4.16 BrainRouter can build a **codebase knowledge graph**: Atlas scans the workspace,
extracts a node per file / function / class with `contains` and `imports` edges, and an enrichment
pass adds summaries, tags, layers, and a guided tour (`buildBaseGraph` → `enrichAtlasGraph`). It
persists per workspace (`readAtlasGraph`), renders in the desktop Atlas panel, pushes to the brain
(`atlas_put`/`atlas_get`), and has a deterministic change-impact projection
(`buildAtlasChangeContext`) that already rides the desktop code-review prompt.

**And the agent never sees any of it.** The graph is built by a human typing `/atlas`, read by a
human opening a panel. Nothing in the turn loop consumes it:

- Every session starts cold. The agent re-derives "what is this repo, where do things live" by
  grepping — spending tool calls and tokens on questions the graph already answers.
- A prompt that names a subsystem gets no map of it. The agent finds `reviews/` by search even
  though Atlas knows its files, layers, and summaries.
- An edit lands with no impact awareness. `buildAtlasChangeContext` can say "14 files in 3 layers
  depend on this" — but only the desktop reviewer ever hears it, never the agent that just made
  the edit.
- The graph silently rots. Nothing tracks that HEAD moved since `analyzedAt`/`gitCommitHash`;
  nothing rebuilds; a stale map misleads instead of orienting.

Meanwhile the hook layer has the same gap in miniature: `session-start` and `session-end` exist in
the `HookEvent` union (CC-parity, 0.4.17) and are listed by `/guard` — **and are never fired**.
A user can script `stop` or `user-prompt-submit` today, but not the two moments that bound a
session.

The lesson of ADR-020/ADR-032 applies directly: a capability the loop does not deterministically
consume is a capability that does not exist. Model adherence is not the mechanism — bounded,
deterministic taps in the turn runtime are (the same reasoning that put the learning checkpoint at
turn-end in code, not in a prompt).

## 2. What this is

Wire the existing graph into the loop at four deterministic moments, and finish the session hook
pair while standing at the same seams:

1. **Session start → orientation.** The first turn of a session gets a compact, bounded map block:
   project name/languages, layer names with file counts, the tour's first stops, and a staleness
   note when HEAD has moved since the graph was built. Once per session, only when a graph exists.
2. **Each prompt → retrieval.** A prompt whose terms match graph nodes (names, paths, tags,
   summaries) gets the top matches injected as a bounded block — file summaries and where they
   live — before the model starts grepping. Deterministic scoring with a coverage gate: weak
   matches inject nothing.
3. **Each edit → blast radius.** Files the agent wrote this turn are mapped onto the graph at
   turn end; their dependents-by-layer summary is injected into the next turn via the existing
   stop-context channel. The agent that just edited a load-bearing file is told so before it
   continues.
4. **On demand → a tool.** `atlas_context` (read tier): the agent queries the graph itself —
   orientation or term lookup — when it wants more than the automatic taps injected.

Plus the hook pair: `session-start` fires at the first turn of a session (its `additionalContext`
joins the first prompt, the same contract `stop` and `user-prompt-submit` already honor), and
`session-end` fires alongside the existing `endSession()` checkpoint. And upkeep: when a graph
exists but HEAD moved, the base graph rebuilds in the background (enrichment summaries carried
forward), so the map tracks the code without anyone re-running `/atlas`.

## 3. Decisions

### D1 · Deterministic taps, not model discretion

Every injection above is code in the turn runtime — `contextPreparationPhase` for orientation and
retrieval, the turn-end finalization for blast radius — never an instruction the model may skip.
The tool is the only discretionary surface, and it is additive. This is the ADR-032/ADR-041
posture: what must happen every time is engineering; the model owns judgement on top of it.

### D2 · Bounded, and byte-neutral when absent

No graph ⇒ no reads, no blocks, no behavior change of any kind — every tap is a cheap existence
check first. With a graph: orientation ≤ ~1.5 KB once per session, retrieval ≤ ~2 KB per matching
prompt (coverage-gated, min-prompt-length floor), blast radius ≤ ~1 KB per turn that edited mapped
files. Ceilings are code, not guidance.

### D3 · The graph is a local, regenerable cache — never committed, never trusted as instructions

Atlas output stays a per-workspace artifact (as today). Injected blocks are data for the model —
summaries and tags pass through the same untrusted-content discipline as any workspace text; a
graph cannot grant tools, approve actions, or carry directives.

### D4 · Staleness is stated, refresh is background, enrichment is never auto-spent

The orientation block names drift honestly (`graph built at <sha>, HEAD has moved`). Auto-refresh
rebuilds the **deterministic base graph only** (scan + extract, no LLM), backgrounded and
debounced by HEAD change, and only when a graph already exists — building from nothing stays a
deliberate `/atlas`. Enrichment (`carryForwardSummaries` preserves prior LLM work across rebuilds)
re-runs only when a person asks. Knobs live in `cli.atlas.*` (config.json), defaults on for
inject/refresh-if-stale, because a map you must remember to refresh is the failure mode of §1.

### D5 · The session hook pair completes the CC-parity contract

`session-start` fires once per session at first-turn context assembly; hook `additionalContext`
joins the first prompt exactly as `user-prompt-submit` context does; `deny` is not honored there
(a session is not a prompt — nothing to block). `session-end` fires (advisory, bounded timeout)
inside `endSession()`, co-located with the ADR-032 checkpoint hosts already await. User hooks and
the Atlas taps are independent: the taps run with no hooks configured, and the hooks fire with no
graph built.

## 4. What this does not do

- No tree-sitter / parser dependency — Atlas extraction stays heuristic (its documented trade).
  Fidelity upgrades are a separate decision.
- No same-turn tool-result mutation for blast radius — the next-turn stop-context channel keeps
  the in-flight message array inviolate (ADR-041 D4).
- No auto-enrichment spend, no committed graph, no cross-workspace graph sharing beyond the
  existing `atlas_put`/`atlas_get`.
- No claim of recall parity with a compiler-grade index — the reviews-side TS index (ADR-025/039)
  remains the exact-revision authority for assurance; Atlas is orientation, not evidence.

## 5. Delivery board

- [x] **S1 — Session hook pair.** Fire `session-start` (once per session, additionalContext →
  first prompt, sessionTitle applied) and `session-end` (inside `endSession()`); `/guard` list
  becomes true. *(#1594 — 3 turn-driven tests; a session switch is a new start, silent agents
  suppressed.)*
- [x] **S2 — Orientation + staleness.** Once-per-session Atlas orientation block (project, layers,
  tour heads) with the drift note when HEAD moved; `cli.atlas.orient` (default on). *(builders
  #1595; tap wired in the taps slice with S3–S5.)*
- [x] **S3 — Background refresh.** Debounced base-graph rebuild when HEAD moved and a graph exists
  (never from nothing), summaries carried forward by node id, scheduled with `setImmediate` so the
  scan runs while the turn idles on the model call; `cli.atlas.autoRefresh` (default on). *(taps
  slice; predicate + a real git-repo rebuild test.)*
- [x] **S4 — Prompt retrieval.** Deterministic term-match scorer + coverage gate over node names/
  paths/tags/summaries (summary-only matches never pass alone); bounded block each matching turn;
  `cli.atlas.retrieval` (default on). *(builders #1595; tap in the taps slice.)*
- [x] **S5 — Blast radius.** The write tools' touched paths are recorded per turn and mapped onto
  the graph at turn end (`buildAtlasChangeContext`); the dependents-by-layer block rides the
  stop-context channel into the next turn. *(taps slice; verified through a real write_file turn.)*
- [x] **S6 — `atlas_context` tool.** Read-tier builtin (spec + catalog + capability owner +
  handler, both generated catalogs refreshed) so the agent can pull the map on demand. *(#1595.)*

## 6. How this will be judged

- **The agent stops asking the repo what the graph knows.** On a workspace with a built graph, a
  "where does X live" prompt injects the matching nodes, and the first turn carries orientation —
  observable in the request trace (`/inspect`).
- **Fixed behavior when absent.** Delete the graph: every test asserting byte-neutrality still
  passes; no tap reads, no block appears.
- **An edit to a load-bearing file is followed by its blast radius** in the next turn's context,
  computed, not asserted.
- **A stale map says so.** Move HEAD, start a session: the orientation carries the drift note and
  a background rebuild lands a fresh base graph without blocking any turn.
- **The hook pair is real.** A workspace `session-start` hook's additionalContext appears in the
  first prompt; `session-end` observably fires before host shutdown completes.

# BrainRouter Roadmap

This is the top-level planning index. Keep it short. Detailed release
plans live in [`brainrouter-roadmap/`](brainrouter-roadmap/), and shipped
changes live in [`CHANGELOG.md`](CHANGELOG.md).

---

## Current Status

| Track | Version | State | Read next |
|---|---|---|---|
| In flight | **0.4.3** | In flight — `/rewind --files` + `/context` window header landed; Brain Phases 2-5 next | [`brainrouter-changelog/0.4.3.md`](brainrouter-changelog/0.4.3.md) |
| Latest | **0.4.2** | Shipped — 2026-05-30 | [`brainrouter-changelog/0.4.2.md`](brainrouter-changelog/0.4.2.md) |
| Shipped | **0.4.1** | Shipped — 2026-05-29 | [`brainrouter-changelog/0.4.1.md`](brainrouter-changelog/0.4.1.md) |
| Shipped | **0.4.0** | Shipped — 2026-05-28 | [`brainrouter-changelog/0.4.0.md`](brainrouter-changelog/0.4.0.md) |
| Previous | **0.3.9** | Shipped — 2026-05-28 | [`CHANGELOG.md`](CHANGELOG.md#039---2026-05-28) |
| Previous | **0.3.8** | Shipped — 2026-05-26 | [`CHANGELOG.md`](CHANGELOG.md#038---2026-05-26) |
| Previous | **0.3.7** | Shipped — 2026-05-26 | [`CHANGELOG.md`](CHANGELOG.md#037---2026-05-26) |

---

## Release Sequence

| Release | Theme | Status |
|---|---|---|
| **[0.3.6](brainrouter-roadmap/0.3.6.md)** | CLI UX tranche, multi-workflow, relevance judge, context budget | Shipped — 2026-05-25 |
| **[0.3.7](brainrouter-roadmap/0.3.7.md)** | Terminal UI redesign, in-terminal config wizard, full Ink chat REPL, CLI/server env separation, multi-agent registry foundations | Shipped — 2026-05-26 |
| **[0.3.8](brainrouter-roadmap/0.3.8.md)** | CLI delegation reliability and quick wins | Shipped — 2026-05-26 |
| **[0.3.9](brainrouter-roadmap/0.3.9.md)** | Memory briefing + cache-first loop + CLI knobs → `config.json` | Shipped — 2026-05-28 |
| **[0.4.0](brainrouter-roadmap/0.4.0.md)** | Persona injection + Federation Stages 1-3 + CLI multi-agent Phase 2 + brain-side design pass | Shipped — 2026-05-28 |
| **[0.4.1](brainrouter-roadmap/0.4.x.md)** | A1-A4 augmentations + CLI multi-agent Phase 3-4 + Brain Phase 1 (job queue + agent registry) | Shipped — 2026-05-29 |
| **[0.4.2](brainrouter-roadmap/0.4.x.md)** | Federation Stage 5, CLI multi-agent Phases 5-6, durable workflows + live `/workflows` viewer, **full CLI parity**, version centralization, docs + MCP API reference | Shipped — 2026-05-30 |
| **[0.4.3](brainrouter-roadmap/0.4.x.md)** | **Memory depth complete (MEM-1…14)** — capture→provenance→drill-down, blackboard, tree, vault, AST chunker, benchmark gate, job kinds, governance, redaction, RBAC schema ✓; CLI fully or foundationed — `/context memory`/offloads, headless JSONL, cost segment, repair telemetry, registry guard ✓ + tested foundations for `/bg`, prefix-drift, verify-detect, exec-policy, agent-def validation, grouped inbox. Follow-ups (live-loop / interactive wiring) → 0.4.4 | Finalizing |
| **[0.5.0](brainrouter-roadmap/0.5.0.md)** | Fullscreen TUI, plugin marketplace, **CLI parity (extensibility polish)** | Sketched |

---

## What Each Upcoming Release Means

> Shipped releases (0.3.x, 0.4.0, 0.4.1) live in [`CHANGELOG.md`](CHANGELOG.md)
> and `brainrouter-changelog/`. This section only describes work that is
> still ahead.

### 0.4.3 — Memory depth (source chunks → tree) + CLI debugging & ops

Shipped so far: `/rewind --files` file restore, `/context` window-fill header,
the agent transcript debugger (`/agents tree` / `why` / `transcript` /
`replay`), the `source_documents` + `source_chunks` foundation, **token-aware
capture wired into the turn pipeline → batch-level provenance** (records cite
their source chunks; `memory_verify` returns excerpts) **→ `memory_fetch_source_chunk`
drill-down**, the **blackboard commit pipeline** (`memory_blackboard_review`),
**AST-aware code chunking**, a **governance dry-run** (`memory_governance_plan`),
**repair telemetry** + a **prompt-cache hit line** in `/context`, and the
**command-registry taxonomy guard**.

**CLI — full set**

- **Background & detachment ~:** `/bg` — `BgRunRegistry` state model + `/ps`
  formatter shipped ✓; live turn-detachment / log-streaming / `/fg` / `/stop`
  rewires the turn loop (follow-up, verify live).
- **Debugging & explainability:** `/context memory` decision view ✓ (planned →
  used → skipped sources + injected records); `/context prefix` per-component
  drift diff ✓ (foundation; the live view is a follow-up); repair telemetry ✓
  (scavenged / truncation / storm counts in `/context`).
- **Cost ✓:** opt-in `cost` status segment (turn USD + cache-hit %) + a
  `/context` prompt-cache hit-ratio line. *(offloaded/child fields can extend it.)*
- **Headless ✓:** `brainrouter run --format jsonl` — a versioned, stable
  per-event stream (turn_start / status / tool / child / text / turn_end+cost /
  error) for CI and external orchestrators.
- **Safety ~:** unified execution-policy decision module ✓ (`decideExecutionPolicy`
  matching the live access-mode tiers); routing every I/O path through it is the
  follow-up.
- **Verification ~:** `/verify detect` project-profile + build/test/lint recipe ✓;
  sandbox-run + post-edit LSP diagnostics is the follow-up (needs a live toolchain).
- **Ergonomics:** command-registry cleanup ✓ (help + palette lockstep, taxonomy
  guard); `/context offloads` browser ✓; grouped `/inbox` pane ✓ (`--watch` +
  inline-accept follow-up); `/agents create` / `/pack create` **validation** ✓
  (interactive wizard + dry-run follow-up).
- **Packaging (after 0.4.3 stabilizes):** shell completions, Homebrew tap,
  one-line installer.

**Brain-side memory — full set** *(depth before breadth)*

- **Source layer ✓:** `source_documents` + `source_chunks` tables + store.
- **Token-aware capture ✓:** chunk sources on every turn; extracted records
  cite their source-chunk ids; `memory_verify` returns source excerpts.
  *(Batch-level provenance; per-record attribution refines later.)*
- **Blackboard commit pipeline ✓:** stage extraction candidates → reconcile /
  conflict-check → commit to cognitive records with an audit trail.
  *(Pipeline + `memory_blackboard_review` tool; live-extraction rerouting later.)*
- **Memory tree ✓:** durable source/topic/global summary hierarchy (append leaf
  → seal bucket → summarize parent → walk/drill via `memory_tree_walk`), generic
  mechanics in `tree/tree.ts` kept separate from policy. *(deterministic
  summarizer; LLM summaries + auto-build later.)*
- **AST-aware code chunking ✓** (TS/JS/Python/Rust, line-based fallback) and a
  read-only **vault mirror ✓** (`memory_vault_export` — markdown + hash ledger,
  idempotent, redacted; DB authoritative).
- **Recall drill-down ✓:** `memory_fetch_source_chunk` (full chunk + parent doc
  + neighbours) **and** `memory_tree_walk` (walk roots / drill a node).
- **Retrieval benchmark harness:** one command, fixed datasets, FTS / hybrid /
  rerank / tree / AST modes, JSON + markdown summary, regression thresholds,
  CI-friendly.
- **Brain jobs:** new kinds for chunking, blackboard reconcile, tree
  seal/digest, vault export, and benchmark eval.
- **Governance & hygiene:** a governance dry-run ✓ (`memory_governance_plan` —
  preview what would archive/delete by filter); an offload reclaimer (retention
  + orphan cleanup); uniform redaction ✓ across source chunks, blackboard
  candidates, offload previews, and vault exports.

Cross-cutting ✓: every new table carries `user_id` + `workspace_tag` scope
columns so team/RBAC can arrive later without migration; 0.4.3 stays
local-first (columns NULL until federation populates them). Carried infra:
git-worktree session isolation.

### 0.5.0 — Power User Surface

- Fullscreen `/focus` TUI.
- Plugin marketplace and trust/signature model.
- Cross-harness handoff UX on top of federation.
- **Brain-side Phase 6:** engineering sync providers (Git, GitHub, local docs,
  terminal logs) and proactive situation reports. Tasks: `BRAIN-P6-TN`.

### CLI Parity (rolling — 0.4.2 → 0.5.0)

Bringing the CLI up to the leading agentic-CLI feature bar. Grouped by
area; each item lands in the version noted.

- **Workflows & orchestration (0.4.2 — shipped).** Durable workflow run
  engine (per-step `run.json` ledger); a `/workflows` viewer showing live run
  status + step timeline (not just artifact folders); and above-prompt
  notifications when a background run finishes while you're idle.
- **Review & quality (0.4.2 — shipped).** `/review --fix` applies + verifies
  the surviving findings; first-class `/simplify` (behavior-preserving
  cleanup).
- **Effort & model (0.4.2 — shipped).** `/effort xhigh` (alias `max`);
  `/model --session` (this-session-only switch); `cli.fallbackModel` runtime
  fallback on model-not-found.
- **Timeline & context (0.4.2 — shipped).** `/rewind` to fork from an earlier
  turn; `/context` token breakdown (per-skill / per-tool / per-briefing).
- **Background & shell UX (0.4.2 shipped `!`; `/bg` → 0.4.3).** The `!` shell
  escape from the composer shipped in 0.4.2; `/bg` (push the in-flight
  response to the background) needs turn-detachment infra and moves to 0.4.3.
- **Extensibility polish (0.5.0).** `/reload-skills`; `disallowed-tools` in
  skill/command frontmatter; a message-display hook; first-use approval for
  third-party MCP servers; and real modal vim editing in the composer.

*Out of scope:* remote control / mobile push and first-party browser
control (would arrive only via an external MCP server, not core).

---

## Documentation Map

| File | Purpose |
|---|---|
| [`brainrouter-roadmap/README.md`](brainrouter-roadmap/README.md) | Roadmap index and release table |
| [`brainrouter-roadmap/0.3.9.md`](brainrouter-roadmap/0.3.9.md) | Pre-0.4 memory, cache, repair, cost, and config plan |
| [`brainrouter-roadmap/0.3.8.md`](brainrouter-roadmap/0.3.8.md) | CLI delegation reliability plan |
| [`CHANGELOG.md`](CHANGELOG.md) | Current shipped/in-flight changes |
| [`brainrouter-changelog/README.md`](brainrouter-changelog/README.md) | Per-version changelog index |

---

## Wishlist After 0.5.0

- Docker image for the MCP server.
- Dashboard memory explorer with recall score explanations.
- Dashboard parity with CLI goal, hook, and multi-agent workflows.
- Verified provider matrix for OpenAI, Anthropic, Gemini, OpenRouter,
  LM Studio, and Ollama.
- `@kinqs/brainrouter-sdk` 1.0 public API lock.

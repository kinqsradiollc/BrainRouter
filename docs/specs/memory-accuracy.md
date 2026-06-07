# Spec: Memory Accuracy (0.4.14)

> Status: **DRAFT — design only, not yet approved. No memory-engine code until
> sign-off.** Target: **0.4.14 — "Memory Accuracy"** (point release; 0.5.0 stays
> the power-user surface). Owner: TBD.
> Measurement gate: `brainrouter-benchmark` (MemBench · LoCoMo · LongMemEval).

## Objective

Raise BrainRouter's recall accuracy on long-term-memory benchmarks — **driven by
measured failures, not guesses.** The benchmark suite is now the gate: every
change is accepted only if it moves the numbers in the right direction without
regressing the others.

This is the deferred **MEM-accuracy** track, now justified and scoped by real
data from three benchmark families.

## Evidence (benchmark run 2026-06-07, gemma-4-e2b, 3000-record haystack / 30 q)

BrainRouter configs, R@5 (recall_any@5 for LongMemEval), best per row in bold:

| Dataset | record type | retriever (keyword/vector) | + reranker | + judge | full |
|---|---|---|---|---|---|
| MemBench ps-fm (factual) | short fact | 0.83 | **0.97** | 0.83 | 0.93 |
| LoCoMo | short turn | 0.37 | **0.75** | 0.35 | 0.55 |
| LongMemEval-S | **long session** | **0.80** | 0.27 | 0.10 | 0.13 |

**The pattern:** on short records the reranker + judge are big wins; on
**long-session** records they actively destroy recall. Diagnosis (with data):

- **Sessions are long** — LongMemEval records median **~10,500 chars (~2,600
  tokens)**, p90 ~17k, max ~78k.
- **Reranker truncates docs to 700 chars** (`store/reranker.ts`) = ~7% of a
  median session → scores the wrong snippet → pushes gold out of top-k (0.80 →
  0.27), and is slow (12.5 s/q).
- **Judge over-rejects** (`store/relevance-judge.ts`: "When in doubt, reject";
  missing verdicts default to rejected; no floor). On long sessions it returns
  **~0.6 results/query** (rejects nearly everything) → gold found 3/30 → 0.10.
- **Vector adds nothing** (vector_rrf ≡ keyword) — one embedding over a 2,600-token
  session is a blurry average; can't out-rank BM25 on a specific-fact query.

## Root cause: record granularity

BrainRouter stores **one record per session/document**. There is chunking for
*code* (`agents/registry` chunker) but **none for conversational memory**. Every
value-add stage assumes a *short* record, so long sessions break all of them at
once. The unifying fix is **chunk-level recall** (passage/turn granularity with a
parent link), which should lift reranker, judge, and vector together.

## Workstreams (proposed — IDs continue the MEM-* scheme; MEM-19 = bench judge mode)

> **MEM-AUDIT lands first and is review-gated** — per the call to "dig deep into
> memory before adjusting." No engine changes until the audit + this spec are
> signed off.

### MEM-AUDIT — recall pipeline deep-dive (no code)
Map the live pipeline end-to-end: capture → store/embed → FTS/vector → RRF →
reranker → judge → graph expansion. Document where record granularity is fixed,
where truncation/rejection happen, and the exact knobs. Output: an addendum to
this spec + a per-stage instrumentation plan. **Deliverable for review.**

### MEM-CHUNK — conversational record chunking
Chunk long sessions/documents into passage/turn-level records on capture, with a
`parentId`/`sessionId` link; recall returns chunks but can roll up to the parent
(so `recall_any@session` still works). Configurable target size; backfill path
for existing memories. *Files: `memory/capture.ts`, store schema, `recall.ts`
roll-up.* **Success: LongMemEval reranker/judge ≥ retriever 0.80; LoCoMo +
MemBench non-regressing.**

### MEM-RERANK — length-aware reranking
Rerank at **chunk** level (post-MEM-CHUNK) and/or raise the 700-char cap /
length-gate the reranker so it never scores <X% of a record. *Files:
`store/reranker.ts`, `recall.ts`.* **Success: reranker stops hurting LongMemEval;
keeps LoCoMo 0.75 / MemBench 0.97.**

### MEM-JUDGE — judge floor + long-context safety
Never let the judge collapse the result set to 0 (floor = top-N retriever
results when the judge rejects/fails); judge on **chunks** not whole sessions;
optional larger-context judge model knob. *Files: `store/relevance-judge.ts`,
`recall.ts` judge stage.* **Success: judge returns ≥N results/query; LongMemEval
judge ≥ retriever; precision wins on short records preserved.**

### MEM-VEC — embedding granularity
With chunk-level records, re-measure vector's contribution; if still flat,
investigate embedding model/dims/normalization. **Success: vector measurably
beats FTS-only on ≥1 dataset.**

### MEM-EVAL — close the benchmark loop
Add a **chunked-LongMemEval** variant to test the granularity hypothesis
directly; re-run the full matrix after each workstream; track deltas in a
`brainrouter-changelog` entry. Keep MemBench + LoCoMo + LongMemEval green.

## Success criteria (acceptance for 0.4.14)

1. **LongMemEval** reranker and judge configs ≥ the plain retriever (**0.80**
   recall_any@5) — i.e. the smart stages stop hurting long sessions. Stretch:
   approach the recency baseline (0.93).
2. **No regressions:** LoCoMo reranker ≥ 0.75; MemBench factual reranker ≥ 0.95.
3. **Judge** never returns 0 results on a query that had retriever hits.
4. Every change validated by a benchmark re-run (delta recorded).

## Sequencing

`MEM-AUDIT` → review → `MEM-CHUNK` → (`MEM-RERANK`, `MEM-JUDGE`, `MEM-VEC` in
parallel) → `MEM-EVAL` re-benchmark after each. Each workstream = its own
stacked branch + PR into `release/0.4.14`, benchmark delta in the PR body.

## Out of scope (0.4.14)

- Per-question LongMemEval haystacks (impractical for the live MCP adapter).
- The **0.5.0 "power-user surface / TUI-native"** track (unchanged) — this memory
  work is a 0.4.14 point release ahead of it.
- CLI / workflow changes (0.4.13 multi-agent delivery continues separately).

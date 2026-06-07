# MEM-AUDIT — Recall Pipeline Deep-Dive (0.4.14)

> **Read-only audit. No engine changes in this doc.** Companion to
> [`memory-accuracy.md`](memory-accuracy.md). All line refs are
> `brainrouter/src/memory/` at the 0.4.14 branch point.

## 1. Recall pipeline map (`recall.ts` → `recall()`, L210+)

| # | Stage | Code | Width knob |
|---|---|---|---|
| 1 | FTS5 BM25 | `store.searchCognitiveFts` (L238) | `RECALL_FTS_LIMIT` (15) |
| 2 | Vector (if embeddings ready) | embed query → `searchCognitiveVec` (L243–250) | `RECALL_VEC_LIMIT` (15) |
| 3 | file-path matches | `expandWithFilePathMatches` (L239) | — |
| 4 | RRF fuse | `1/(60+rank)` over the 3 streams (L315–338) | — |
| 5 | score + neural-spark | `baseScoreFromRrf` + priority/churn/intent/citation boosts (L355+) | — |
| 6 | slice to top-K | `sparkScoredResults.slice(0, topResults)` (L491) | `RECALL_TOP_RESULTS` (5) |
| 7 | **reranker** (if key set) | `rerankerService.rerank(content[])` (L501–515) | `RECALL_RERANK_POOL` (20) → `RERANKER_TOP_N` |
| 8 | MMR diversity (only if no reranker) | `selectMMR` (L523–533) | `RECALL_DIVERSITY` |
| 9 | **LLM judge** (if key set) | `relevanceJudge.judge` → keep `approvedIndices` (L548–573) | `RELEVANCE_JUDGE_ENABLED` |
| 10 | graph expansion + refs | `expandRecallWithGraph`, MEM-17 refs (L575+) | — |

The atomic unit through the whole pipeline is a **`cognitive_record`**
(`{record_id, content}`). Stages 7 & 9 operate on `record.content` directly.

## 2. Two stores (this is the crux)

Capture (`capture.ts`, production `memory_capture_turn`) writes **two** things:
- **`source_chunks`** — the raw turn/document, **already chunked** + citable
  (`getSourceChunksByDocument`, `sqlite.ts` L1015+). *Not* the recall unit.
- **`cognitive_records`** — short **extracted facts** via
  `extractCognitiveMemories` every N turns (`extractEveryNTurns=3`, L56/L97–106).
  **This is the recall unit.**

So in normal use, recall ranks **short extracted facts** — reranker/judge behave.

**`memory_import` bypasses extraction**: it stores pre-formed memories straight as
`cognitive_records`. The benchmark imports one record per *whole session* → the
recall unit becomes a **2,600-token raw session**, not a fact. Same gap is hit by
any real "import a long document / paste a big transcript" path.

## 3. Where it breaks on long records (evidence)

LongMemEval records: median **~10.5k chars (~2,600 tok)**, p90 17k, max 78k.

| Failure | Mechanism (code) | Benchmark symptom |
|---|---|---|
| **Reranker truncation** | `store/reranker.ts` L68–73: `doc.length > 700 ? substring(0,700)` ("512-token limit") → scores ~7% of a session | reranker R@5 0.80 → **0.27**, 12.5 s/q |
| **Judge over-reject** | `store/relevance-judge.ts`: "When in doubt, reject" (L93); missing verdict ⇒ rejected (L189); **no floor**; on long candidates the 2B judge can't verify | returns **~0.6 results/q** → R@5 **0.10** |
| **Vector blur** | one embedding per long record = averaged; `searchCognitiveVec` over whole-session vectors | vector_rrf ≡ keyword (0.80) — vector adds nothing |
| **No recall-time chunking** | recall unit fixed at `cognitive_record.content`; no sub-record windows for stages 7/9 | all of the above |
| **Top-K collapse** | judge replaces `topResults` with approved subset, can be `[]` (L559) | 0-result queries |

On **short** records (MemBench facts, LoCoMo turns) the same stages are wins
(reranker 0.97 / 0.75) — confirming this is a **long-record handling** problem,
not a retrieval-quality problem. The plain retriever finds gold 26/30 (0.80).

## 4. Instrumentation gap (why diagnosis needed code spelunking)

`RecallExplanation` (L291+) tracks `rerankerUsed`, `rerankerCandidates`,
`judgeApproved/Rejected` — but **not** surfaced per-recall in a way we can trend,
and **no** record-length / truncation-rate signal. Proposed (MEM-AUDIT output):

- per-stage in→out counts (fts/vec/rrf/rerank/judge) on every recall op.
- **record content-length histogram** + **reranker truncation rate** (% of
  candidates over the cap) in the recall op log + `memory-explain`.
- judge: log approved/rejected **with reasons** when it drops to 0.

These ship cheaply (extend the existing op-log write at L308) and let us watch the
fix land in prod, not just the benchmark.

## 5. Knob inventory

Configurable: `RECALL_{FTS,VEC,RERANK_POOL,TOP_RESULTS}_LIMIT`,
`RECALL_DIVERSITY[_LAMBDA]`, `RELEVANCE_JUDGE_ENABLED`, `RERANKER_*`,
per-call `limitsOverride`/`disableReranker`/`disableJudge` (MEM-19).
**Hard-coded (no knob):** reranker 700-char / 200-char caps; judge reject-bias +
no result floor; `extractEveryNTurns=3`; no record chunking for recall.

## 6. How this refines the workstreams

- **MEM-CHUNK** is confirmed the root fix, with a sharper definition: *long*
  cognitive records (import / large-doc) should be **chunked into child records
  with a `parentId`**, recall rolling up to parent — and `memory_import` of long
  content should chunk (optionally extract) rather than store one mega-record.
  The `source_chunks` machinery already chunks raw content and can be reused.
- **MEM-RERANK**: rerank at **chunk** level; the 700-char cap becomes a knob and
  is mooted once records are chunk-sized.
- **MEM-JUDGE**: add a **result floor** (never return fewer than min(N, retriever
  hits)); judge chunks, not whole sessions.
- **MEM-VEC**: re-measure after chunking (focused embeddings should finally beat
  FTS); only then chase model/dims.
- **MEM-EVAL**: add a chunked-LongMemEval variant to isolate the granularity
  effect; also add an **extracted-capture** benchmark path (run records through
  `memory_capture_turn` rather than raw `memory_import`) to measure production
  fidelity.

## 7. Open question for review

The benchmark imports raw sessions (no extraction). Do we want 0.4.14 to:
- (a) make the **recall pipeline robust to long records** (chunk-on-store / rerank
  chunks / judge floor) — fixes imports + large docs + the benchmark; **or**
- (b) also/instead route imports through **extraction** so cognitive records stay
  short (closer to production) — but that changes the unit and complicates
  session-level `recall_any` gold.

Recommendation: **(a) first** (robustness is a real user-facing gap and unblocks
the benchmark), evaluate (b) under MEM-EVAL.

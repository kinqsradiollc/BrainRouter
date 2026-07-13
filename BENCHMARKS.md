# BrainRouter benchmarks

This is the evidence index for BrainRouter performance claims. It separates current reproducible suites from archived measurements so backend or harness changes are not presented as an apples-to-apples continuation.

## Reading the results correctly

- `brainrouter-benchmark/` is the current comparison harness. It drives BrainRouter through the public authenticated MCP transport and compares it with deterministic baseline adapters.
- `brainrouter/benchmark/results/` contains committed reference artifacts produced by the earlier in-process memory harness. Those results remain useful historical evidence, but they used the former SQLite/FTS5 backend and do not measure the current Postgres runtime.
- A result is only current when its artifact records the tested commit, configuration, dataset, platform, and date.
- The `tiny` fixture is a smoke test. Do not use it for product claims.
- A system reported as `unavailable` was not silently replaced by a fallback.

## Current benchmark harness

The harness covers two tracks:

| Track  | What it measures                                                                                                                                                 | Main commands    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Memory | Recall, precision, ranking, latency, and bounded load behavior across full-dump, capped-dump, BM25, deterministic-vector, hybrid, and live BrainRouter adapters. | `bench:memory:*` |
| CLI    | Deterministic command behavior, live behavior, transcript scoring, and decision-trace comparison.                                                                | `bench:cli:*`    |

List available datasets:

```bash
npm run bench:datasets:list
```

Run a smoke preflight:

```bash
npm run bench:memory:dry-run -- --fixture tiny
npm run bench:cli:dry-run -- --fixture tiny
```

Run the current memory comparison against a bounded dataset:

```bash
export BRAINROUTER_BENCH_MCP_URL=http://127.0.0.1:3747/mcp
export BRAINROUTER_BENCH_API_KEY=<benchmark-only-api-key>

npm run bench:memory:retrieval -- \
  --fixture longmemeval \
  --max-records 3000 \
  --max-queries 100 \
  --progress
```

Use a disposable benchmark organization and database. The live adapter imports records through `memory_import`; never target production data.

Generate reports from completed runs:

```bash
npm run bench:report
```

Results are written beneath `brainrouter-benchmark/results/`; generated summaries are written beneath `brainrouter-benchmark/reports/`.

### Current harness configuration

| Variable                                             | Purpose                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `BRAINROUTER_BENCH_MCP_URL`                          | Streamable HTTP MCP endpoint for the tested BrainRouter server.                    |
| `BRAINROUTER_BENCH_API_KEY` or `BRAINROUTER_API_KEY` | Benchmark-only credential.                                                         |
| `BRAINROUTER_BENCH_SYSTEM_ID`                        | Stable ID for the tested configuration in comparison reports.                      |
| `BRAINROUTER_BENCH_SYSTEM_LABEL`                     | Human-readable configuration label.                                                |
| `BRAINROUTER_BENCH_MCP_TIMEOUT_MS`                   | Per-call timeout; defaults to five minutes for local model stacks.                 |
| `BRAINROUTER_BENCH_IMPORT_BATCH_SIZE`                | Import batch size; defaults to 500.                                                |
| `BRAINROUTER_BENCH_SKIP_IMPORT=1`                    | Reuse an already imported dataset. Use only when its identity and scope are known. |
| `BRAINROUTER_BENCH_FORCE_UNAVAILABLE`                | Record why a configuration must not be scored.                                     |

## Archived reference results

The following artifacts were produced before the Postgres migration. Their raw files are retained for auditability; they are not current production-runtime measurements.

| Suite                                               | Date       | Backend                                 | Platform                 | Commit       | Raw data                                                                                     |
| --------------------------------------------------- | ---------- | --------------------------------------- | ------------------------ | ------------ | -------------------------------------------------------------------------------------------- |
| Retrieval, scale, load, end-to-end, real embeddings | 2026-05-17 | SQLite/FTS5 in-process harness          | Darwin arm64, Node 22.16 | `864751d`    | [`brainrouter/benchmark/results/2026-05-17/1/`](brainrouter/benchmark/results/2026-05-17/1/) |
| Code symbol isolation and related-file ranking      | 2026-05-31 | In-process code chunk/retrieval fixture | Darwin arm64, Node 22.16 | Not recorded | [`brainrouter/benchmark/results/2026-05-31/`](brainrouter/benchmark/results/2026-05-31/)     |

### Archived retrieval quality

LongMemEval-S, 500 questions:

| Pipeline        |  Recall@5 | Recall@10 | Recall@20 |    NDCG@10 |        MRR |
| --------------- | --------: | --------: | --------: | ---------: | ---------: |
| FTS-only        | **0.970** |     0.990 |     0.996 |     0.8989 |     0.9138 |
| Hybrid (RRF)    |     0.966 |     0.986 | **0.998** | **0.9068** | **0.9209** |
| Hybrid + rerank |     0.948 |     0.990 | **0.998** |     0.8862 |     0.8860 |

The archived result found that a general-purpose cross-encoder reduced Recall@5 on identifier-heavy records. That is why reranking remains explicit and must be benchmarked for the deployed corpus rather than assumed to help.

Raw artifacts:

- [`longmemeval_fts.json`](brainrouter/benchmark/results/2026-05-17/1/longmemeval_fts.json)
- [`longmemeval_hybrid.json`](brainrouter/benchmark/results/2026-05-17/1/longmemeval_hybrid.json)
- [`longmemeval_hybrid+rerank.json`](brainrouter/benchmark/results/2026-05-17/1/longmemeval_hybrid+rerank.json)

### Archived code recall

| Metric                                      |      Value |
| ------------------------------------------- | ---------: |
| Samples across TypeScript, Python, and Rust |          3 |
| Expected symbols                            |          8 |
| Isolated symbols                            |          8 |
| Symbol recall                               | **100.0%** |
| Chunks per isolated symbol                  |       1.13 |

The related-file fixture used 40 files in eight independent clusters. Its recorded Recall@10 was 100%, MRR was 1.0, and returned context was 19.4% of the whole-repository fixture. See [`code-recall.json`](brainrouter/benchmark/results/2026-05-31/code-recall.json) and [`code-scale.json`](brainrouter/benchmark/results/2026-05-31/code-scale.json).

### Archived scale and context efficiency

The older top-10 retrieval harness held recalled context near 450 tokens while the synthetic full-history baseline grew with corpus size.

| Observations | FTS5 search | Hybrid search | Full-history tokens | Retrieved tokens |
| -----------: | ----------: | ------------: | ------------------: | ---------------: |
|          240 |    0.235 ms |      0.486 ms |              10,504 |              450 |
|        1,000 |    0.322 ms |      1.002 ms |              43,834 |              450 |
|        5,000 |    0.861 ms |      3.799 ms |             220,335 |              450 |
|       10,000 |    1.735 ms |      9.693 ms |             440,973 |              450 |
|       50,000 |    6.493 ms |     39.708 ms |           2,216,173 |              450 |

These are in-process latency measurements, not HTTP/Postgres service latency. Full details are in [`SCALE.md`](brainrouter/benchmark/results/2026-05-17/1/SCALE.md).

### Archived end-to-end result

The local-model fixture compared a full workspace dump with retrieved context over five questions.

| Metric           | Full dump | Retrieved context | Recorded change |
| ---------------- | --------: | ----------------: | --------------: |
| Judge score, 1–5 |       3.8 |               3.4 |          -10.5% |
| Request latency  |  9,430 ms |          2,545 ms |    73.0% faster |
| Prompt tokens    |    14,767 |               717 |     95.1% fewer |

This is a small historical fixture and should be read as evidence of the latency/context trade-off, not a general accuracy guarantee. See [`END-TO-END.md`](brainrouter/benchmark/results/2026-05-17/1/END-TO-END.md).

## Publishing a new claim

Before changing a public number:

1. build the exact commit being measured;
2. use a disposable Postgres database and benchmark organization;
3. record provider/model IDs, retrieval configuration, dataset version, hardware, and date;
4. include failures and unavailable adapters in the result set;
5. run enough queries for the stated conclusion;
6. commit the raw machine-readable result and generated report; and
7. update this file without overwriting older evidence.

Never compare a new Postgres/MCP run directly with an archived in-process SQLite latency as if the harness were unchanged.

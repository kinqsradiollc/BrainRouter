# BrainRouter Benchmark — Published Results

Reproducible memory-recall results for BrainRouter vs. the standard memory
strategies (full-context dump, recency cap, BM25, vector, hybrid) on three
long-term-memory benchmarks: **MemBench**, **LongMemEval-S**, **LoCoMo**.

Runs are seeded (`1337`) over the same bounded slice for every system. Numbers
are produced on a local stack (`gemma-4-e2b` + vLLM `bge-reranker-v2-m3` +
`nomic-embed-text-v1.5`); treat absolute latencies as local-model-bound.

## Files

| File | What it is |
|---|---|
| [`0.4.14-recall-delta.md`](0.4.14-recall-delta.md) | **Start here** — the 0.4.14 recall-quality writeup: before/after deltas, per-fix breakdown, caveats, reproduce steps. |
| [`memory-comparison.md`](memory-comparison.md) | The full per-split × per-config comparison table (current pipeline). |

Raw per-run JSON lives under `../results/` (git-ignored — regenerate locally).

## Reproduce

```bash
cd brainrouter-benchmark
./make-bench-envs.sh
export SPLITS="ps-fm os-fm ps-rm os-rm longmemeval:s locomo"
./bench-load.sh
./bench-all.sh
node build-comparison-report.mjs > reports/memory-comparison.md
```

Full instructions: [`../README.md`](../README.md).

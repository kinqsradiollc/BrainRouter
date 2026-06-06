# BrainRouter Benchmark Datasets

This directory only commits small smoke fixtures and benchmark manifests.
Large external benchmark data is not checked in.

## Built-in Fixtures

| Fixture | File | Purpose |
|---|---|---|
| `tiny` | `tiny-memory.json` | Deterministic CI smoke test for retrieval metrics and result writing |

## MemBench

MemBench is the primary external memory benchmark family for research runs.
Use `membench.manifest.json` to see the canonical split IDs, source links, and
expected converted output paths.

The large raw archives should be placed under `datasets/raw/membench/`, then
converted into BrainRouter benchmark format under `datasets/membench/`. Both
directories are ignored except for `.gitkeep` placeholders.

List known datasets:

```bash
npm run bench:datasets:list
```

Run a converted MemBench split:

```bash
npm run bench:memory:retrieval -- --fixture membench:ps-fm:10k
```

Until a split has been imported, benchmark runs fail with `dataset-resolver`
instructions rather than producing fake scores.

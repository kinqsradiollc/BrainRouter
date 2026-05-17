# LongMemEval-S Benchmark Results

BrainRouter's memory engine retrieval performance evaluated against the [LongMemEval](https://arxiv.org/abs/2410.10813) dataset (ICLR 2025).

This benchmark isolates the **retrieval recall** of the memory engine, simulating a robust haystack test.

## Setup

- **Dataset**: LongMemEval-S (500 questions, ~48 sessions per question, ~115K tokens)
- **Source**: [xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
- **Metric**: `recall_any@K` — does ANY gold session appear in top-K retrieved results?
- **Embedding model**: Configured Embedding API Model in `.env` (e.g. `nomic-embed-text-v1.5`, 768 dimensions)
- **No LLM in the loop**: Pure retrieval evaluation, no answer generation or judge

## Retrieval Configurations

BrainRouter evaluates various levels of search complexity to optimize speed, accuracy, and resource cost:

* **FTS-only (Full-Text Search)**: Keyword-only search utilizing SQLite's native FTS5 extension with standard BM25 ranking. Highly performant, zero GPU or embedding model overhead, and robust for exact-token lookups (e.g., specific variable names or error logs).
* **Vector-only (Semantic)**: Dense vector retrieval using cosine similarity over the configured embedding API model. Identifies conceptually similar memories even if the exact words differ.
* **Hybrid (RRF)**: Merges FTS keyword search and Vector semantic search using Reciprocal Rank Fusion (RRF). Blends the precise matching of keywords with the contextual breadth of semantic embeddings to return the best balanced results.
* **Decay (Aging)**: Applies a chronological decay multiplier to retrieved candidates' scores. Prioritizes fresh, recent session contexts over older, potentially outdated episodic memories.
* **Skill Boost**: Dynamically boosts the rank of retrieved memories if their skill classifications match the active project workspace skill (e.g. prioritizing Docker memories during devops tasks).
* **Stage 3 Reranker**: Employs a dedicated Cross-Encoder model (like `BAAI/bge-reranker-v2-m3`) to re-score and re-rank the top-20 candidate pool. Evaluates full query-document attention to correct minor positional rank mismatches.

## Results

*Benchmark results have not been generated yet. Run the benchmark scripts below to populate the results.*

## Analysis

*No analysis available yet. Generate and evaluate your benchmark results to see insights here.*

## Reproducibility

```bash
# Download dataset (264 MB)
npm run bench:download-data

# Run FTS-only
npm run bench:longmemeval

# Run BM25+Vector hybrid (requires local @xenova/transformers dev dependency)
npm run bench:longmemeval:hybrid

# Run Full Quality Suite (evaluates various BrainRouter retrieval configurations)
npm run bench:quality
```

### Viewing the Results

The scripts will print a condensed summary to your terminal immediately after finishing. 

Additionally, the `longmemeval` scripts save the full, detailed results (including per-question scores and specific retrieved session IDs) in JSON format for further analysis. You can view these result files at:
- **`benchmark/results/longmemeval_fts_YYYY-MM-DD.json`**
- **`benchmark/results/longmemeval_hybrid_YYYY-MM-DD.json`**
- **`benchmark/results/longmemeval_hybrid+rerank_YYYY-MM-DD.json`**

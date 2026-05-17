# LongMemEval-S Benchmark Results

BrainRouter's memory engine retrieval performance evaluated against the [LongMemEval](https://arxiv.org/abs/2410.10813) dataset (ICLR 2025).

This benchmark isolates the **retrieval recall** of the memory engine, simulating a robust haystack test.

## Why We Benchmark (Motivation & Goals)

Evaluating our embedded memory architecture against industry-standard workloads guarantees that BrainRouter remains both highly accurate and lightning-fast. We benchmark to prove five primary core value propositions:

1. **Verify Off-Heap Scalability**: We want to prove that transferring our indexing and storage logic to a C-based SQLite virtual table (`FTS5` + Vector) entirely offloads V8's Heap. At a 50,000+ observation scale, this prevents the V8 garbage collection pauses and memory bloat typical of in-memory, pure JavaScript data structures.
2. **Mitigate LLM Context Pressure & API Costs**: By utilizing multi-layered memory prioritization (Chronological Decay + Workspace Skill Boosts), we aim to show that we can condense prompt contexts by **up to 98%** (from 22k tokens down to 450 tokens) without losing critical facts, drastically lowering token billing.
3. **Solve the Lexical-Semantic Trade-Off**: We benchmark FTS5, pure vector, and hybrid (RRF) search configurations to verify that hybrid retrieval eliminates keyword search failures (e.g. searching 'testing framework' when the memory only lists 'Vitest package') without sacrificing exact-token matches (e.g. finding exact UUIDs or error codes).
4. **Zero-API Local Embedding Validation**: Using local, in-process embedding pipelines, we ensure developers can maintain complete privacy and run zero-cost semantic search engines entirely in-process on their local machines.
5. **High Concurrency & Load Proofing**: Replicating randomized workload distributions on identical seeds (up to 100k queries) allows us to stress-test and guarantee BrainRouter's absolute stability, performance, and transaction safety as a high-concurrency, local-first MCP server.

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

# Run FTS-only (LongMemEval)
npm run bench:longmemeval

# Run BM25+Vector hybrid (LongMemEval - requires local @xenova/transformers dev dependency)
npm run bench:longmemeval:hybrid

# Run Full Quality Suite (evaluates various BrainRouter retrieval configurations)
npm run bench:quality

# Run the In-Process SQLite Scale Benchmark
npm run bench:scale

# Run the Real Embeddings Quality Suite (uses local TransformersEmbedder)
npm run bench:real-embeddings

# Run the 100k Concurrency Load Test (matches agentmemory seed)
npm run bench:load

# Run the End-to-End integration benchmark
npm run bench:e2e

# Run all benchmarks sequentially (Overnight Run - consolidated inside a single index folder)
npm run bench:overnight
```

### Viewing the Results

The scripts will print a condensed summary to your terminal immediately after finishing. 

Additionally, the `longmemeval` scripts save the full, detailed results (including per-question scores and specific retrieved session IDs) in JSON format for further analysis. You can view these result files at:
- **`benchmark/results/longmemeval_fts_YYYY-MM-DD.json`**
- **`benchmark/results/longmemeval_hybrid_YYYY-MM-DD.json`**
- **`benchmark/results/longmemeval_hybrid+rerank_YYYY-MM-DD.json`**

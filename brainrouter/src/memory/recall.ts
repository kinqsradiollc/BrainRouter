/**
 * Recall pipeline — the retrieval flow (keyword/vector/filepath
 * retrieval → reranker → graph expansion).
 *
 * This file is a thin re-export barrel; the implementation lives in cohesive
 * sibling modules under `recall/`:
 *   - `recall/config.ts`   — env-read limit/selection/rerank knobs + the
 *                            pure ranking helpers (blend / route).
 *   - `recall/filters.ts`  — the post-RRF candidate-pool filters (types, scenes,
 *                            federation workspace/project scoping, session-scoping).
 *   - `recall/pipeline.ts` — `MemoryRecallPipeline`, the orchestrator that runs
 *                            the stages against an `IMemoryStore`.
 *
 * The public surface is unchanged — importers of `./recall.js` keep working.
 */
export * from "./recall/config.js";
export * from "./recall/filters.js";
export * from "./recall/pipeline.js";

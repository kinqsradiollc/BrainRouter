/**
 * Retrieval service (ADR-006/008, Wave 1) — the typed port over the brain's
 * recall pipeline. This is the boundary that becomes a deployable retrieval /
 * embeddings service once the brain runs remotely (driver D2/D3); embedded by
 * default, it just wraps the in-process {@link MemoryRecallPipeline}.
 *
 * Additive and behaviour-preserving: `recall.ts` is untouched. The facade holds
 * a pipeline instance and delegates; the factory centralises construction (store
 * + embedding + reranker) so callers depend on the port, not the concrete
 * pipeline.
 */
import type { IMemoryStore, RecallResult } from "@kinqs/brainrouter-types";
import { MemoryRecallPipeline } from "../recall.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { RerankerService } from "../store/reranker.js";

/** The exact parameter shape accepted by the recall pipeline. */
export type RecallParams = Parameters<MemoryRecallPipeline["recall"]>[0];

/** The retrieval contract — query → ranked, graph-expanded memories. */
export interface IRetrievalService {
  recall(params: RecallParams): Promise<RecallResult>;
}

/**
 * {@link IRetrievalService} backed by the in-process recall pipeline. Wraps a
 * `Pick<MemoryRecallPipeline, "recall">` so it delegates without re-implementing
 * any stage (and stays unit-testable without a live store).
 */
export class RetrievalService implements IRetrievalService {
  constructor(private readonly pipeline: Pick<MemoryRecallPipeline, "recall">) {}
  recall(params: RecallParams): Promise<RecallResult> {
    return this.pipeline.recall(params);
  }
}

/** Construct a retrieval service over a fresh recall pipeline from its dependencies. */
export function createRetrievalService(
  store: IMemoryStore,
  embeddingService: EmbeddingService,
  rerankerService: RerankerService,
): IRetrievalService {
  return new RetrievalService(
    new MemoryRecallPipeline(store, embeddingService, rerankerService),
  );
}

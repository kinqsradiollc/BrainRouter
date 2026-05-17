import type { RerankerServiceConfig } from "../types.js";

export interface RankedResult {
  index: number;
  relevanceScore: number;
}

export class RerankerService {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly topN: number;
  private readonly ready: boolean;

  constructor(config: RerankerServiceConfig) {
    this.endpoint = config.endpoint ?? "https://api.cohere.com/v1/rerank";
    this.apiKey = config.apiKey ?? "";
    this.model = config.model ?? "rerank-english-v3.0";
    this.topN = config.topN ?? 5;

    // Graceful fallback: If no API key is provided, disable the reranker service.
    this.ready = !!this.apiKey;
    if (!this.ready) {
      console.error("[BrainRouter] Reranker API key not set. Stage 3 reranking will be disabled. Falling back to RRF-only mode.");
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  getTopN(): number {
    return this.topN;
  }

  /**
   * Reranks documents against a query using Cohere/vLLM /v1/rerank API.
   * Throws if not ready, so always check isReady() first.
   */
  async rerank(params: {
    query: string;
    documents: string[];
    topN?: number;
  }): Promise<RankedResult[]> {
    if (!this.ready) {
      throw new Error("RerankerService is not ready (missing API key)");
    }

    if (params.documents.length === 0) {
      return [];
    }

    const requestTopN = params.topN ?? this.topN;

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query: params.query,
        documents: params.documents,
        model: this.model,
        top_n: requestTopN,
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "(no body)");
      throw new Error(`Reranker API failed: HTTP ${res.status} ${res.statusText} - ${err}`);
    }

    const data = await res.json() as any;
    
    // Example vLLM response:
    // {
    //   'id': 'score-940bec41fb803c3f', 
    //   'model': 'BAAI/bge-reranker-v2-m3', 
    //   'results': [
    //      {'index': 0, 'document': {'text': '...'}, 'relevance_score': 0.997682}, 
    //      {'index': 1, 'document': {'text': '...'}, 'relevance_score': 0.000016}
    //   ]
    // }

    if (!data.results || !Array.isArray(data.results)) {
      throw new Error("Invalid reranker response format: missing 'results' array");
    }

    const rankedResults: RankedResult[] = data.results.map((r: any) => ({
      index: r.index,
      relevanceScore: r.relevance_score
    }));

    return rankedResults;
  }
}

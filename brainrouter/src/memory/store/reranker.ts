import type { RerankerServiceConfig } from "@kinqs/brainrouter-types";
import { fetchWithExternalRetry } from "../util/retry.js";
import { resolveLLMTimeoutMs } from "../llm/llm-response.js";

export interface RankedResult {
  index: number;
  relevanceScore: number;
}

/**
 * MEM-RERANK (0.4.14) — per-doc char budget sent to the cross-encoder. The old
 * hardcoded 700 (~180 tokens) discarded ~93% of a long session; with MEM-CHUNK a
 * record is now ≤ one chunk, so the reranker should score the whole chunk.
 * Default 1500 chars (~375 tokens) stays within a 512-token reranker once the
 * ~50-token query is added. Lower it for stricter rerankers; raise for larger.
 */
export function rerankerMaxDocChars(env: NodeJS.ProcessEnv = process.env): number {
  const def = 1500;
  const raw = env.BRAINROUTER_RERANKER_MAX_DOC_CHARS;
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 100 ? Math.min(n, 8000) : def;
}

export class RerankerService {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly topN: number;
  private readonly timeoutMs: number;
  private readonly ready: boolean;

  constructor(config: RerankerServiceConfig) {
    this.endpoint = config.endpoint ?? "https://api.cohere.com/v1/rerank";
    this.apiKey = config.apiKey ?? "";
    this.model = config.model ?? "rerank-english-v3.0";
    this.topN = config.topN ?? 5;
    this.timeoutMs = Math.max(1000, config.timeoutMs ?? resolveLLMTimeoutMs({
      endpoint: this.endpoint,
      requestedMs: 60_000,
      envVarNames: ["BRAINROUTER_RERANKER_TIMEOUT_MS", "BRAINROUTER_LLM_TIMEOUT_MS"],
      localMinimumMs: 120_000,
    }));

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

    // Graceful truncation: keep inputs within a typical 512-token reranker.
    // Query → 200 chars (~50 tokens). Docs → BRAINROUTER_RERANKER_MAX_DOC_CHARS
    // (default 1500 ~375 tokens; MEM-RERANK). With MEM-CHUNK records are chunk-
    // sized, so this covers a whole chunk instead of the old 700-char (~7% of a
    // long session) window that wrecked long-record reranking.
    const maxDocChars = rerankerMaxDocChars();
    const safeDocuments = params.documents.map(doc =>
      doc.length > maxDocChars ? doc.substring(0, maxDocChars) + "..." : doc
    );
    const safeQuery = params.query.length > 200 
      ? params.query.substring(0, 200) + "..." 
      : params.query;

    const res = await fetchWithExternalRetry(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query: safeQuery,
        documents: safeDocuments,
        model: this.model,
        top_n: requestTopN,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }, {
      label: "Reranker API",
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

import type { EmbeddingServiceConfig } from "@kinqs/brainrouter-types";
import { fetchWithExternalRetry } from "../util/retry.js";
import { acquireEmbeddingSlot } from "../llm/llm-semaphore.js";
import { normalizeRequestTimeoutMs, parseRequestTimeoutMs, requestTimeoutSignal } from "../util/request-timeout.js";

/**
 * Per-call embedding timeout. DEFAULT 0 = no timeout: the embed call WAITS for
 * the server rather than degrading recall to FTS-only on a slow-but-alive
 * embedder. A bound is OPT-IN via BRAINROUTER_EMBEDDING_TIMEOUT_MS (positive int,
 * ≥1000) as a backstop; `0` / empty / junk → no timeout. See request-timeout.ts.
 */
export function embeddingTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseRequestTimeoutMs(env.BRAINROUTER_EMBEDDING_TIMEOUT_MS);
}

export class EmbeddingService {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensions: number;
  private readonly timeoutMs: number;
  private readonly ready: boolean;

  constructor(config: EmbeddingServiceConfig) {
    this.endpoint = config.endpoint ?? "https://api.openai.com/v1/embeddings";
    this.apiKey = config.apiKey ?? "";
    this.model = config.model ?? "text-embedding-3-small";
    this.dimensions = config.dimensions ?? 768;
    // 0 = no timeout: wait for the server (see embeddingTimeoutMs / request-timeout.ts).
    this.timeoutMs = normalizeRequestTimeoutMs(config.timeoutMs ?? embeddingTimeoutMs());

    // Graceful fallback: If no API key is provided, we disable the embedding service.
    this.ready = !!this.apiKey;
    if (!this.ready) {
      console.error("[BrainRouter] Embedding API key not set. Vector search will be disabled. Falling back to FTS-only mode.");
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Get an embedding for a single text.
   * Throws if not ready, so always check isReady() first.
   */
  async embed(text: string): Promise<Float32Array> {
    if (!this.ready) {
      throw new Error("EmbeddingService is not ready (missing API key)");
    }

    // DEDICATED embedding pool (BRAINROUTER_EMBED_CONCURRENCY), NOT the
    // generative LLM semaphore. Embedding is usually a different backend (a
    // local embedder) from the chat/extraction LLM (often cloud); coupling them
    // at the generative cap=1 stalled the recall query-embed behind a slow
    // background generation, blowing the MCP reply past the client timeout. The
    // pool still bounds embedding bursts on its own backend.
    const release = await acquireEmbeddingSlot();
    try {
      const res = await fetchWithExternalRetry(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: this.model,
        }),
        signal: requestTimeoutSignal(this.timeoutMs),
      }, {
        label: "Embedding API",
      });

      if (!res.ok) {
        const err = await res.text().catch(() => "(no body)");
        throw new Error(`Embedding API failed: HTTP ${res.status} ${res.statusText} - ${err}`);
      }

      const data = await res.json() as any;
      if (!data.data || !data.data[0] || !Array.isArray(data.data[0].embedding)) {
        throw new Error("Invalid embedding response format");
      }

      const vec = data.data[0].embedding as number[];
      return new Float32Array(vec);
    } finally {
      release();
    }
  }
}

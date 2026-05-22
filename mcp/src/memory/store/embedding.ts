import type { EmbeddingServiceConfig } from "@brainrouter/types";
import { fetchWithExternalRetry } from "../retry.js";
import { acquireLLMSlot } from "../llm-semaphore.js";

export class EmbeddingService {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensions: number;
  private readonly ready: boolean;

  constructor(config: EmbeddingServiceConfig) {
    this.endpoint = config.endpoint ?? "https://api.openai.com/v1/embeddings";
    this.apiKey = config.apiKey ?? "";
    this.model = config.model ?? "text-embedding-3-small";
    this.dimensions = config.dimensions ?? 768;

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

    // Same backend as ModelLLMRunner — go through the shared semaphore so
    // embedding requests count against the concurrency cap. Otherwise a burst
    // of new cognitive records can fire N embeddings + N LLM calls in
    // parallel and overwhelm LM Studio just like before.
    const release = await acquireLLMSlot();
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

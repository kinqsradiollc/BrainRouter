import type { EmbeddingServiceConfig } from "../types.js";

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
    this.dimensions = config.dimensions ?? 1536;

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

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: text,
        model: this.model,
      }),
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
  }
}

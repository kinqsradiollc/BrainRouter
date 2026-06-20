import type { EmbeddingServiceConfig } from "@kinqs/brainrouter-types";
import { fetchWithExternalRetry } from "../util/retry.js";
import { acquireEmbeddingSlot } from "../llm/llm-semaphore.js";

/**
 * Per-call embedding timeout. Embedding is a fast vectorize call, not a
 * token-generating completion — so it must NOT inherit the generative local
 * floor (`BRAINROUTER_LOCAL_LLM_MIN_TIMEOUT_MS`, up to 10 min). A hung embedding
 * on the RECALL path would block the whole `memory_recall` reply; bound it so
 * recall degrades to FTS-only fast. Default 30s, clamp [1000, 120000].
 * Env: BRAINROUTER_EMBEDDING_TIMEOUT_MS.
 */
export function embeddingTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const def = 30_000;
  const raw = env.BRAINROUTER_EMBEDDING_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 120_000) : def;
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
    // Bounded, generative-floor-free timeout (see embeddingTimeoutMs).
    this.timeoutMs = Math.max(1000, config.timeoutMs ?? embeddingTimeoutMs());

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
        signal: AbortSignal.timeout(this.timeoutMs),
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

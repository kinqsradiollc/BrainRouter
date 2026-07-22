import type { EmbeddingServiceConfig } from "@kinqs/brainrouter-types";
import { fetchWithExternalRetry } from "../util/retry.js";
import { acquireEmbeddingSlot } from "../llm/llm-semaphore.js";
import { resolveEmbeddingsUrl } from "../../providers/wireFormat.js";
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

/**
 * Fallback pgvector column width for a BRAND-NEW store when the real embedder
 * dimension isn't known yet (nothing embedded, no recorded meta). It is NOT a
 * source of truth: `cognitive_vec` adopts whatever a running store already has
 * at boot, and the write path re-dimensions it to the live embedder's actual
 * output length. 768 matches common local embedders (nomic-embed-text, bge).
 * The dimension is DB-driven — never set from env.
 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

export class EmbeddingService {
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private readonly dimensions: number;
  private readonly timeoutMs: number;
  private ready: boolean;

  constructor(config: EmbeddingServiceConfig) {
    this.endpoint = config.endpoint ?? "https://api.openai.com/v1/embeddings";
    this.apiKey = config.apiKey ?? "";
    this.model = config.model ?? "text-embedding-3-small";
    this.dimensions = config.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
    // 0 = no timeout: wait for the server (see embeddingTimeoutMs / request-timeout.ts).
    this.timeoutMs = normalizeRequestTimeoutMs(config.timeoutMs ?? embeddingTimeoutMs());

    // Providers live in the DB (dashboard → AI Providers), applied a moment later
    // by applyProviderOverrides → reconfigure(). Starting unconfigured is the
    // EXPECTED ADR-012 path, not a fault — stay silent here. A single accurate
    // provider summary is logged once after applyProviderOverrides settles.
    this.ready = !!this.apiKey;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** ADR-010 P2 — apply a DB-resolved provider (endpoint/apiKey/model) at runtime,
   *  recomputing readiness. Only called when a DB config exists (else env stands). */
  reconfigure(cfg: { endpoint?: string; apiKey?: string; model?: string }): void {
    if (cfg.endpoint) this.endpoint = cfg.endpoint;
    if (cfg.apiKey) this.apiKey = cfg.apiKey;
    if (cfg.model) this.model = cfg.model;
    // A DB-configured provider is intentional, so it's ready with a valid endpoint
    // + model even WITHOUT an api key — local embedders (LM Studio, Ollama, etc.)
    // are keyless. The key is only sent when present. Silent: reconfigure() runs
    // on every admin provider save, so the boot summary (engine) is the one place
    // that reports readiness, once.
    this.ready = !!(this.endpoint && this.model);
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
      // The saved endpoint is a /v1 base; the embeddings PATH is appended here so
      // the operator never has to type `/embeddings` (parity with the LLM wire).
      const res = await fetchWithExternalRetry(resolveEmbeddingsUrl(this.endpoint), {
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

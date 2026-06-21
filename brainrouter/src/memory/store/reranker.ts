import type { RerankerServiceConfig } from "@kinqs/brainrouter-types";
import { fetchWithExternalRetry } from "../util/retry.js";
import { acquireRerankerSlotOrNull } from "../llm/llm-semaphore.js";

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

/**
 * Per-call reranker timeout. A cross-encoder rerank must NOT inherit the
 * generative local-endpoint floor (`BRAINROUTER_LOCAL_LLM_MIN_TIMEOUT_MS`, up to
 * 10 min) — a reranker that hasn't answered should fail over to RRF, not stall
 * the whole `memory_recall` reply ("client disconnected before reply").
 *
 * Default 25s (SPEC 01): on a CPU CrossEncoder under multi-agent load, each
 * agent is a separate process hitting one shared single-worker server, so a
 * single rerank can legitimately take 15-25s — the old 15s default aborted those
 * mid-flight and dropped recall to RRF on every trip. 25s lets the slow-but-alive
 * CPU call finish; the circuit breaker still bounds a genuinely-down server
 * (≤3 slow trips → 30s cooldown), and parallel pile-up is shed by
 * rerankerAcquireWaitMs (below) so raising this does NOT stall queued recalls.
 * On GPU/Cohere, lower it (e.g. 10-15s) via env once p95 is measured.
 * Clamp [1000, 120000]. Env: BRAINROUTER_RERANKER_TIMEOUT_MS.
 */
export function rerankerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const def = 25_000;
  const raw = env.BRAINROUTER_RERANKER_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 120_000) : def;
}

/**
 * Max time a recall waits for the single reranker slot before shedding to RRF.
 * The reranker slot is cap-1 (a CPU cross-encoder is single-worker), so under
 * multi-agent parallel load concurrent recalls contend for it. Rather than queue
 * unboundedly — which stalls the `memory_recall` reply until the slot frees
 * (× the raised timeout above) and trips "client disconnected" — a recall that
 * can't get the slot within this window skips the cross-encoder and uses RRF.
 * This is load-shedding, NOT a reranker failure: it does NOT trip the breaker.
 * It is the responsiveness↔quality knob; the real cure for CPU saturation is the
 * GPU vLLM backend. Default 15s, clamp [1000, 120000].
 * Env: BRAINROUTER_RERANKER_ACQUIRE_WAIT_MS.
 */
export function rerankerAcquireWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const def = 15_000;
  const raw = env.BRAINROUTER_RERANKER_ACQUIRE_WAIT_MS;
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1000 ? Math.min(n, 120_000) : def;
}

/** Consecutive failures before the reranker circuit opens. Default 3. */
export function rerankerBreakerThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const def = 3;
  const n = Number.parseInt(env.BRAINROUTER_RERANKER_BREAKER_THRESHOLD ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : def;
}

/** How long the reranker circuit stays open (skipped) once tripped. Default 30s. */
export function rerankerBreakerCooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const def = 30_000;
  const n = Number.parseInt(env.BRAINROUTER_RERANKER_BREAKER_COOLDOWN_MS ?? "", 10);
  return Number.isFinite(n) && n >= 1000 ? n : def;
}

export class RerankerService {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly topN: number;
  private readonly timeoutMs: number;
  private readonly acquireWaitMs: number;
  private readonly ready: boolean;

  // Circuit breaker — a flapping / overloaded reranker should be SKIPPED for a
  // cooldown, not retried (and timed-out) on every single recall. `isAvailable()`
  // reflects the breaker so recall silently uses RRF while it's open; no
  // per-recall network wait and no log spam.
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;

  constructor(config: RerankerServiceConfig) {
    this.endpoint = config.endpoint ?? "https://api.cohere.com/v1/rerank";
    this.apiKey = config.apiKey ?? "";
    this.model = config.model ?? "rerank-english-v3.0";
    this.topN = config.topN ?? 5;
    // Bounded, generative-floor-free timeout (see rerankerTimeoutMs).
    this.timeoutMs = Math.max(1000, config.timeoutMs ?? rerankerTimeoutMs());
    this.acquireWaitMs = rerankerAcquireWaitMs();
    this.breakerThreshold = rerankerBreakerThreshold();
    this.breakerCooldownMs = rerankerBreakerCooldownMs();

    // Graceful fallback: If no API key is provided, disable the reranker service.
    this.ready = !!this.apiKey;
    if (!this.ready) {
      console.error("[BrainRouter] Reranker API key not set. Stage 3 reranking will be disabled. Falling back to RRF-only mode.");
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * True when the reranker is configured AND its circuit breaker is closed.
   * Recall checks THIS (not `isReady`) so a down/flapping reranker is skipped
   * entirely during the cooldown — recall just uses RRF, with no network wait.
   */
  isAvailable(): boolean {
    return this.ready && Date.now() >= this.breakerOpenUntil;
  }

  getTopN(): number {
    return this.topN;
  }

  private recordSuccess(): void {
    if (this.consecutiveFailures > 0 || this.breakerOpenUntil > 0) {
      console.error("[BrainRouter] Reranker recovered; circuit closed.");
    }
    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.breakerThreshold && Date.now() >= this.breakerOpenUntil) {
      this.breakerOpenUntil = Date.now() + this.breakerCooldownMs;
      console.error(
        `[BrainRouter] Reranker circuit opened after ${this.consecutiveFailures} consecutive failures; ` +
        `skipping rerank for ${Math.round(this.breakerCooldownMs / 1000)}s (using RRF).`,
      );
    }
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
    // Defense-in-depth: recall checks isAvailable(), but a direct caller during
    // an open breaker fails fast (no network wait) so we don't pay the timeout.
    if (Date.now() < this.breakerOpenUntil) {
      throw new Error("Reranker circuit open (cooling down after repeated failures); using RRF");
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

    // Bound concurrency (default cap 1): a local cross-encoder is usually a
    // single-worker CPU backend, so concurrent recalls must NOT pile onto it —
    // the queued requests would each blow the per-call timeout. Acquire AFTER
    // the breaker check above so an open breaker still fast-fails (no queuing).
    //
    // Bounded wait (SPEC 01): under multi-agent parallel load this single slot is
    // contended; rather than queue unboundedly (stalling the recall reply until a
    // slot frees), give up after acquireWaitMs and shed to RRF. This is
    // load-shedding, NOT a server failure: the throw happens BEFORE the try below,
    // so recordFailure() is never called (the breaker must not open from
    // shedding) and no network request is made. recall's catch routes it to RRF.
    const release = await acquireRerankerSlotOrNull(this.acquireWaitMs);
    if (!release) {
      throw new Error("Reranker slot busy under parallel load; using RRF");
    }
    try {
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

      this.recordSuccess();
      return rankedResults;
    } catch (e) {
      this.recordFailure();
      throw e;
    } finally {
      release();
    }
  }
}

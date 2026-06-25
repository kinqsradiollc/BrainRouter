/**
 * Concurrency caps for outbound requests from this MCP process.
 *
 * Why this exists: a single user turn can trigger an avalanche of calls inside
 * the MCP child — cognitive extraction, contradiction detection (one per
 * existing-record neighbour), graph extraction, focus-shift detection, plus the
 * 5-min sweeper backfilling old sensory rows. On consumer hardware that floods a
 * local GPU and triggers LM Studio auto-unload / OOM / queue overflow.
 *
 * TWO independent pools, because generation and embedding are usually DIFFERENT
 * backends with different cost profiles:
 *
 *   - Generative LLM  (acquireLLMSlot)       — chat/extraction/synthesis/judge.
 *       Cap: BRAINROUTER_LLM_MAX_CONCURRENT (default 2; <1 disables the cap).
 *   - Embedding       (acquireEmbeddingSlot) — the vector retriever's embedder.
 *       Cap: BRAINROUTER_EMBED_CONCURRENCY  (default 8).
 *   - Reranker        (acquireRerankerSlot)  — the cross-encoder rerank server.
 *       Cap: BRAINROUTER_RERANKER_MAX_CONCURRENT (default 8; 0/<1 = unbounded).
 *       Recall now WAITS for the reranker with no per-call timeout (see
 *       request-timeout.ts), so concurrent recalls no longer blow a deadline by
 *       queue-stacking the server — the old cap-1 "single-worker CPU" guard is
 *       obsolete and was the throughput ceiling under multi-agent load. The cap
 *       still bounds simultaneous in-flight sockets to the rerank origin; raise it
 *       (or set 0 = unbounded) for a scalable GPU/vLLM/Cohere backend, lower it to
 *       1 to serialize against a strictly single-worker server.
 *
 * Coupling them under ONE cap=1 semaphore (the pre-0.4.15 behaviour) stalled the
 * recall query-embed behind a slow background generation, so `memory_recall`
 * blew past the client's MCP timeout → "client disconnected before reply". The
 * embedder is its own (often local) backend; it gets its own pool.
 */

import { readEmbedConcurrency } from "../util/concurrency.js";

function resolveGenerativeCap(): number {
  const raw = process.env.BRAINROUTER_LLM_MAX_CONCURRENT;
  if (!raw) return 2;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return Number.POSITIVE_INFINITY;
  return parsed;
}

function resolveRerankerCap(): number {
  const raw = process.env.BRAINROUTER_RERANKER_MAX_CONCURRENT;
  if (!raw) return 8; // concurrent recalls are safe now that there's no per-call timeout
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return Number.POSITIVE_INFINITY;
  return parsed;
}

/** A simple promise-queue semaphore with a re-resolvable cap. */
class Semaphore {
  private cap: number;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capResolver: () => number) {
    this.cap = capResolver();
  }

  async acquire(): Promise<() => void> {
    if (!Number.isFinite(this.cap)) {
      // Cap disabled — passthrough.
      return () => {};
    }
    if (this.inFlight < this.cap) {
      this.inFlight++;
      return this.makeRelease();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight++;
    return this.makeRelease();
  }

  /**
   * Like acquire(), but gives up after `timeoutMs` and resolves `null` instead
   * of queuing indefinitely. Lets a caller load-shed (e.g. recall → RRF) when a
   * single-slot backend is saturated, rather than stalling behind the queue.
   */
  async acquireOrNull(timeoutMs: number): Promise<(() => void) | null> {
    if (!Number.isFinite(this.cap)) {
      // Cap disabled — passthrough.
      return () => {};
    }
    if (this.inFlight < this.cap) {
      this.inFlight++;
      return this.makeRelease();
    }
    return new Promise<(() => void) | null>((resolve) => {
      let settled = false;
      const grant = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.inFlight++;
        resolve(this.makeRelease());
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Drop our waiter so a later release doesn't hand us a phantom slot.
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(grant);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  state(): { cap: number; inFlight: number; queued: number } {
    return { cap: this.cap, inFlight: this.inFlight, queued: this.waiters.length };
  }

  reset(): void {
    this.cap = this.capResolver();
    this.inFlight = 0;
    this.waiters.length = 0;
  }
}

const generativeSemaphore = new Semaphore(resolveGenerativeCap);
const embeddingSemaphore = new Semaphore(() => readEmbedConcurrency());
const rerankerSemaphore = new Semaphore(resolveRerankerCap);

/**
 * Acquire one GENERATIVE LLM slot (chat / extraction / synthesis / judge).
 * Returns a release function the caller MUST invoke when the call finishes
 * (success OR failure):
 *
 *   const release = await acquireLLMSlot();
 *   try { ...llm call... } finally { release(); }
 */
export async function acquireLLMSlot(): Promise<() => void> {
  return generativeSemaphore.acquire();
}

/**
 * Acquire one EMBEDDING slot. Separate pool from the generative cap so a
 * latency-critical recall query-embed never queues behind a slow generation.
 */
export async function acquireEmbeddingSlot(): Promise<() => void> {
  return embeddingSemaphore.acquire();
}

/**
 * Acquire one RERANKER slot (default cap 1). Bounds how many rerank requests
 * this process sends concurrently to the cross-encoder server, so concurrent
 * recalls don't queue-stack a single-worker CPU backend into timeouts.
 */
export async function acquireRerankerSlot(): Promise<() => void> {
  return rerankerSemaphore.acquire();
}

/**
 * Acquire one RERANKER slot, but give up after `timeoutMs` (resolving `null`)
 * instead of queuing indefinitely. Under multi-agent parallel load the cap-1
 * reranker slot is contended; a recall that can't get it quickly should shed to
 * RRF rather than stall the `memory_recall` reply. `null` = "slot busy, skip".
 */
export async function acquireRerankerSlotOrNull(timeoutMs: number): Promise<(() => void) | null> {
  return rerankerSemaphore.acquireOrNull(timeoutMs);
}

/** Exposed for tests / diagnostics. */
export function getSemaphoreState(): { cap: number; inFlight: number; queued: number } {
  return generativeSemaphore.state();
}

/** Exposed for tests / diagnostics. */
export function getEmbeddingSemaphoreState(): { cap: number; inFlight: number; queued: number } {
  return embeddingSemaphore.state();
}

/** Exposed for tests / diagnostics. */
export function getRerankerSemaphoreState(): { cap: number; inFlight: number; queued: number } {
  return rerankerSemaphore.state();
}

/**
 * Allow tests (or a future /config tool) to reset all caps and clear waiters
 * without restarting the process.
 */
export function resetSemaphoreForTests(): void {
  generativeSemaphore.reset();
  embeddingSemaphore.reset();
  rerankerSemaphore.reset();
}

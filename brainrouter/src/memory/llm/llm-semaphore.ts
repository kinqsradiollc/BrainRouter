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
 *
 * ADR-027 D12 (P1-5) — THE WAIT QUEUE IS BOUNDED AND AGE-AWARE. A cap without a
 * bounded queue only moves the overload: callers pile up without limit, and each
 * one still eventually gets a slot long after its own deadline passed. Two
 * bounds now apply to every pool:
 *
 *   - BRAINROUTER_LLM_MAX_QUEUE   (default 256) — how many callers may wait.
 *       A new arrival beyond this is REJECTED with `SemaphoreOverloadError`
 *       rather than queued, so overload surfaces as fast backpressure.
 *   - BRAINROUTER_LLM_MAX_WAIT_MS (default 120_000) — how long a caller may
 *       wait before we assume nobody is listening. Aged-out waiters are shed
 *       before every hand-off, so a freed slot never goes to an abandoned
 *       caller while a fresh one waits behind it.
 *
 * `acquire()` can therefore THROW where it previously could only block. That is
 * deliberate and the call sites are shaped for it: the reranker path sheds to
 * RRF (outside its try, so the circuit breaker never sees it), and a background
 * job fails into its normal backoff-and-retry rather than piling up.
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

/**
 * ADR-027 D12 (P1-5) — thrown when the wait queue is full.
 *
 * The queue used to be unbounded, which turns overload into unbounded memory
 * growth and unbounded latency: callers pile up, every one of them eventually
 * gets a slot, and by the time they do their own deadline has long passed. A
 * bounded queue converts that into fast, explicit backpressure the caller can
 * act on (shed to a cheaper path, or surface a clear "busy" to the user).
 */
export class SemaphoreOverloadError extends Error {
  constructor(public readonly pool: string, public readonly queued: number) {
    super(`${pool} pool is saturated (${queued} already waiting); shed this work instead of queuing.`);
    this.name = "SemaphoreOverloadError";
  }
}

/** How many callers may wait for a slot before new arrivals are rejected. */
function resolveMaxQueue(): number {
  const raw = process.env.BRAINROUTER_LLM_MAX_QUEUE;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return 256;
  return parsed;
}

/**
 * How long a caller may sit in the queue before we assume nobody is listening.
 * Serving a waiter whose client already gave up burns a slot producing a result
 * no one reads, which is exactly the wrong thing to do while saturated.
 */
function resolveMaxWaitMs(): number {
  const raw = process.env.BRAINROUTER_LLM_MAX_WAIT_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return 120_000;
  return parsed;
}

interface Waiter {
  grant(): void;
  shed(): void;
  enqueuedAt: number;
}

/** A simple promise-queue semaphore with a re-resolvable cap. */
class Semaphore {
  private cap: number;
  private inFlight = 0;
  private readonly waiters: Waiter[] = [];
  private shedCount = 0;

  constructor(
    private readonly capResolver: () => number,
    private readonly poolName = "llm",
    private readonly now: () => number = () => Date.now(),
  ) {
    this.cap = capResolver();
  }

  /**
   * Drop waiters that have been queued longer than the age limit. Called before
   * every enqueue and every hand-off so stale entries neither occupy queue
   * capacity nor receive a slot ahead of a caller that is still waiting.
   */
  private shedStale(): void {
    const limit = resolveMaxWaitMs();
    const cutoff = this.now() - limit;
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i]!.enqueuedAt <= cutoff) {
        const [stale] = this.waiters.splice(i, 1);
        this.shedCount++;
        stale!.shed();
      }
    }
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
    this.shedStale();
    const maxQueue = resolveMaxQueue();
    if (this.waiters.length >= maxQueue) {
      throw new SemaphoreOverloadError(this.poolName, this.waiters.length);
    }
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({
        grant: resolve,
        shed: () => reject(new SemaphoreOverloadError(this.poolName, this.waiters.length)),
        enqueuedAt: this.now(),
      });
    });
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
    // This caller already carries its own deadline, so the queue bound applies
    // but the age limit does not — the timeout below is its shedding policy.
    this.shedStale();
    if (this.waiters.length >= resolveMaxQueue()) return null;
    return new Promise<(() => void) | null>((resolve) => {
      let settled = false;
      const waiter: Waiter = {
        grant: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.inFlight++;
          resolve(this.makeRelease());
        },
        shed: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(null);
        },
        enqueuedAt: this.now(),
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Drop our waiter so a later release doesn't hand us a phantom slot.
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      // Shed before handing off: a slot must never go to a caller that has
      // already aged out while a fresher one waits behind it.
      this.shedStale();
      const next = this.waiters.shift();
      if (next) next.grant();
    };
  }

  state(): { cap: number; inFlight: number; queued: number; shed: number } {
    return { cap: this.cap, inFlight: this.inFlight, queued: this.waiters.length, shed: this.shedCount };
  }

  reset(): void {
    this.cap = this.capResolver();
    this.inFlight = 0;
    // Reject rather than abandon: a pending acquire() that is silently dropped
    // never settles, and its caller hangs forever.
    for (const waiter of this.waiters.splice(0)) waiter.shed();
    this.shedCount = 0;
  }
}

const generativeSemaphore = new Semaphore(resolveGenerativeCap, "generative LLM");
const embeddingSemaphore = new Semaphore(() => readEmbedConcurrency(), "embedding");
const rerankerSemaphore = new Semaphore(resolveRerankerCap, "reranker");

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
export function getSemaphoreState(): { cap: number; inFlight: number; queued: number; shed: number } {
  return generativeSemaphore.state();
}

/** Exposed for tests / diagnostics. */
export function getEmbeddingSemaphoreState(): { cap: number; inFlight: number; queued: number; shed: number } {
  return embeddingSemaphore.state();
}

/** Exposed for tests / diagnostics. */
export function getRerankerSemaphoreState(): { cap: number; inFlight: number; queued: number; shed: number } {
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

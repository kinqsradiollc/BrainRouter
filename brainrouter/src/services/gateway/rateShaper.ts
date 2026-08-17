/**
 * ADR-043 S1 (D5) — the rate-shaper: the floor under every egress path.
 *
 * Upstream providers rate-limit by KEY (rpm, concurrency) and answer overflow
 * with 429 + Retry-After. Without an explicit shaper the failure mode is today's
 * wedge — a free-tier upstream stalling a required check while a burst of
 * requests all hit the same limit at once. This bounds and fair-shares that
 * traffic per key:
 *
 *  - a CONCURRENCY cap (max in-flight per key),
 *  - an RPM budget (a sliding 60s window per key),
 *  - RETRY-AFTER backoff (a 429'd key is parked until its Retry-After elapses),
 *  - a bounded QUEUE (callers past the cap wait their turn, FIFO; past the queue
 *    bound they are refused with a retry hint rather than piling on).
 *
 * The `key` is whatever the caller shards by — the shared upstream key, or a
 * per-org managed key (option D), so one tenant cannot starve another. The
 * shaper is PURE and synchronous (an injected clock, no internal timers): the
 * caller does the waiting via `tryAcquire` + the returned `retryAfterMs`, which
 * makes every rule deterministically testable.
 */

export interface RateShaperOptions {
  /** Max concurrent in-flight requests per key. */
  maxConcurrentPerKey: number;
  /** Requests-per-minute budget per key (sliding 60s window). */
  rpmPerKey: number;
  /** Max callers queued (waiting) per key before new ones are refused. */
  maxQueuePerKey: number;
  /** Injected clock (ms). Defaults to Date.now. */
  now?: () => number;
}

export type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; retryAfterMs: number; reason: "concurrency" | "rpm" | "retry-after" | "queue-full" };

interface KeyState {
  inFlight: number;
  /** Timestamps (ms) of requests admitted in the last 60s, for the rpm window. */
  window: number[];
  /** Number of callers currently WAITING on this key (bounded by maxQueuePerKey). */
  queued: number;
  /** Epoch ms until which this key is parked by an upstream Retry-After. */
  retryUntil: number;
}

const WINDOW_MS = 60_000;

export class RateShaper {
  private readonly opts: Required<RateShaperOptions>;
  private readonly keys = new Map<string, KeyState>();

  constructor(options: RateShaperOptions) {
    this.opts = { now: () => Date.now(), ...options };
  }

  private state(key: string): KeyState {
    let s = this.keys.get(key);
    if (!s) { s = { inFlight: 0, window: [], queued: 0, retryUntil: 0 }; this.keys.set(key, s); }
    return s;
  }

  /** Drop window entries older than 60s so the rpm budget is a true sliding window. */
  private prune(s: KeyState, now: number): void {
    if (s.window.length === 0) return;
    const cutoff = now - WINDOW_MS;
    // window is append-ordered, so trim from the front.
    let i = 0;
    while (i < s.window.length && s.window[i] <= cutoff) i += 1;
    if (i > 0) s.window.splice(0, i);
  }

  /**
   * Try to reserve a slot for `key`. On success returns a one-shot `release()`;
   * on failure returns how long to wait before retrying and why. Idempotent per
   * call — a refused caller is NOT counted against concurrency or rpm.
   */
  tryAcquire(key: string, now: number = this.opts.now()): AcquireResult {
    const s = this.state(key);
    this.prune(s, now);

    if (s.retryUntil > now) {
      return { ok: false, retryAfterMs: s.retryUntil - now, reason: "retry-after" };
    }
    if (s.inFlight >= this.opts.maxConcurrentPerKey) {
      // A concurrency slot frees when an in-flight request releases; there is no
      // clock-based deadline, so hint a short poll interval.
      return { ok: false, retryAfterMs: this.pollHint(s, now), reason: "concurrency" };
    }
    if (s.window.length >= this.opts.rpmPerKey) {
      // The oldest request in the window ages out at window[0] + 60s.
      const retryAfterMs = Math.max(1, s.window[0] + WINDOW_MS - now);
      return { ok: false, retryAfterMs, reason: "rpm" };
    }

    s.inFlight += 1;
    s.window.push(now);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        s.inFlight = Math.max(0, s.inFlight - 1);
      },
    };
  }

  /** Register interest in waiting for `key`. Returns false when the queue is full
   *  (the caller should be refused rather than pile on). Pair with `leaveQueue`. */
  enterQueue(key: string): boolean {
    const s = this.state(key);
    if (s.queued >= this.opts.maxQueuePerKey) return false;
    s.queued += 1;
    return true;
  }
  leaveQueue(key: string): void {
    const s = this.state(key);
    s.queued = Math.max(0, s.queued - 1);
  }

  /** An upstream returned 429 + Retry-After: park the key until it elapses so a
   *  burst does not keep hammering a limit the provider already refused. */
  noteRetryAfter(key: string, retryAfterSeconds: number, now: number = this.opts.now()): void {
    const s = this.state(key);
    const ms = Math.max(0, Math.floor(retryAfterSeconds * 1000));
    s.retryUntil = Math.max(s.retryUntil, now + ms);
  }

  /**
   * If the key is currently parked by a prior upstream Retry-After, how many ms
   * remain; else 0. Lets a caller FAST-FAIL a request to a rate-limited key
   * (return 429 + the hint immediately) instead of hammering an upstream that
   * already refused — the direct fix for the review-bot free-tier wedge. No
   * reservation, so nothing to release.
   */
  parkedFor(key: string, now: number = this.opts.now()): number {
    const s = this.keys.get(key);
    if (!s) return 0;
    return s.retryUntil > now ? s.retryUntil - now : 0;
  }

  /** Current queue depth for a key (for the "queue position, not an opaque stall"
   *  surface the ADR asks for). */
  queueDepth(key: string): number {
    return this.state(key).queued;
  }

  private pollHint(s: KeyState, now: number): number {
    // If a retry-after is pending it dominates; otherwise a small fixed poll.
    return s.retryUntil > now ? s.retryUntil - now : 50;
  }
}

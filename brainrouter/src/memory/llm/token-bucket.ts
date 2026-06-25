/**
 * Token-bucket rate limiter (SPEC 01 SUPPORT — inference lanes).
 *
 * The one genuinely-new primitive that the inference-lane work needs: the
 * codebase already bounds *concurrency* (llm-semaphore.ts `Semaphore`) but not
 * sustained *rate*. A quota'd provider — e.g. a free LLM endpoint that returns
 * 502 under sustained load (see SPEC 02's `nemotron-3-ultra-free`) — needs
 * requests/min and/or tokens/min ceilings so a caller can shed to a fallback
 * instead of hammering it.
 *
 * Standard continuously-refilling bucket. `tryConsume` is NON-BLOCKING: it
 * returns `false` when over budget so the caller load-sheds (matching SPEC 01's
 * responsiveness-over-stalling stance) rather than awaiting a refill. Two
 * independent budgets — requests/min and tokens/min — either of which may be
 * omitted (treated as unlimited). Burst capacity equals one minute's budget.
 *
 * MULTI-PROCESS CAVEAT (per SPEC 01): each agent is a separate MCP process, so a
 * bucket instance caps THIS process's rate only. For a true global provider cap
 * across N agent processes, split the budget (`ratePerMin / N`) or enforce it at
 * a shared proxy — a per-process bucket cannot see the other processes' usage.
 *
 * No consumer is wired yet: the reranker is local (no rate limit needed); the
 * rate-limited lanes are the cloud LLM calls, wired in SPEC 02. This is the
 * primitive those lanes will use.
 */

export interface TokenBucketOpts {
  /** Request-count budget per minute. Omit for unlimited. */
  ratePerMin?: number;
  /** Token budget per minute. Omit for unlimited. */
  tokensPerMin?: number;
}

export class TokenBucket {
  private readonly reqMax: number;
  private readonly tokMax: number;
  private reqTokens: number;
  private tokTokens: number;
  private last = Date.now();

  constructor(opts: TokenBucketOpts) {
    this.reqMax = opts.ratePerMin ?? Number.POSITIVE_INFINITY;
    this.tokMax = opts.tokensPerMin ?? Number.POSITIVE_INFINITY;
    // Start full so a fresh bucket allows an immediate burst up to one minute's budget.
    this.reqTokens = this.reqMax;
    this.tokTokens = this.tokMax;
  }

  /** Refill both budgets proportional to elapsed time, capped at their max. */
  private refill(): void {
    const now = Date.now();
    const elapsedMin = (now - this.last) / 60_000;
    // Guard: no elapsed time → nothing to add (also avoids 0 * Infinity = NaN
    // for unlimited budgets, and ignores a backwards clock adjustment).
    if (elapsedMin <= 0) return;
    this.last = now;
    this.reqTokens = Math.min(this.reqMax, this.reqTokens + elapsedMin * this.reqMax);
    this.tokTokens = Math.min(this.tokMax, this.tokTokens + elapsedMin * this.tokMax);
  }

  /**
   * Try to consume one request (and `estTokens` tokens). Returns `true` and
   * deducts when BOTH budgets allow it; returns `false` and deducts NOTHING
   * otherwise, so the caller can shed to a fallback. Non-blocking.
   */
  tryConsume(estTokens = 1): boolean {
    const cost = estTokens > 0 ? estTokens : 1;
    this.refill();
    if (this.reqTokens < 1) return false;
    if (this.tokTokens < cost) return false;
    this.reqTokens -= 1;
    this.tokTokens -= cost;
    return true;
  }

  /** Remaining budget after a refill — for diagnostics / tests. */
  snapshot(): { requests: number; tokens: number } {
    this.refill();
    return { requests: this.reqTokens, tokens: this.tokTokens };
  }
}

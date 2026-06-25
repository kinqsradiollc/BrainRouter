/**
 * Request-timeout policy for the memory pipeline's outbound calls (reranker,
 * embedding, relevance judge, generative extraction).
 *
 * CONTRACT (0.4.15+): by default these calls have NO client-side timeout. Recall
 * and extraction WAIT for the server however long it takes; only a *genuine*
 * failure — connection refused/reset, an HTTP error status, or a malformed body —
 * ends the call. Slowness alone must never abort. A CPU cross-encoder or a local
 * LLM under heavy multi-agent load can legitimately take minutes, and aborting it
 * mid-flight silently degrades recall to RRF (or drops a cognitive/graph extraction)
 * even though the server would have answered.
 *
 * A timeout is OPT-IN. Set the service's `*_TIMEOUT_MS` env to a positive integer to
 * re-impose a bound (e.g. against a flaky cloud endpoint, or as a safety net against
 * a server that accepts the socket but never replies — see the trade-off below).
 * `0`, empty, negative, and junk all mean "no timeout".
 *
 * TRADE-OFF the operator accepts by leaving timeouts off: a server that holds the
 * socket open but never responds will hold the call — and the concurrency slot it
 * occupies — until the socket itself drops. With no timeout there is nothing to
 * count as a failure, so neither a retry nor a circuit breaker can intervene; under
 * a cap-N pool, N such hangs wedge the pool. If that risk matters in a given
 * deployment, set the relevant `*_TIMEOUT_MS` to a generous bound as a backstop.
 */

/**
 * Normalize a `*_TIMEOUT_MS` env value to milliseconds.
 * Positive int → that bound, floored to 1000ms (a sub-second deadline is almost
 * always a misconfiguration). Anything else (`undefined`, empty, `0`, negative,
 * non-numeric) → `0`, meaning "no timeout — wait for the server".
 */
export function parseRequestTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? Math.max(1000, n) : 0;
}

/**
 * Normalize an already-numeric timeout (e.g. one passed through a service config)
 * with the same semantics as {@link parseRequestTimeoutMs}: positive → floored to
 * 1000ms; `0`/negative/non-finite → `0` (no timeout).
 */
export function normalizeRequestTimeoutMs(ms: number | undefined): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.max(1000, ms) : 0;
}

/**
 * Build the `signal` for a `fetch` from a resolved timeout in ms.
 *   - `> 0`  → an `AbortSignal` that aborts the request after `ms`.
 *   - `<= 0` / non-finite → `undefined`: the request waits for the server with no
 *     client-side deadline (a genuine socket error still rejects the fetch).
 */
export function requestTimeoutSignal(ms: number): AbortSignal | undefined {
  return Number.isFinite(ms) && ms > 0 ? AbortSignal.timeout(ms) : undefined;
}

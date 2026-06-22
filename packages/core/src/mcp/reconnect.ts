/**
 * RECONNECT (0.4.12) — Codex-style reconnect/backoff for the LLM call loop.
 *
 * Instead of a hard timeout that kills a turn (or a silent background worker) on
 * the first hiccup, a stalled/disconnected request is treated as a *reconnect*
 * signal: exponential backoff with jitter, honoring a server `Retry-After`, and —
 * when the machine is genuinely OFFLINE — waiting for the link to come back rather
 * than spending the retry budget. This module is the PURE core (backoff math +
 * header parsing); the connectivity probe is the one bounded I/O helper.
 */

const RECONNECT_BASE_MS = 500;
const RECONNECT_FACTOR = 2;
const RECONNECT_CAP_MS = 30_000;

/**
 * Backoff before the next reconnect attempt (1-based). Exponential
 * `base · factor^(attempt-1)` with ±10% jitter, capped. A positive `retryAfterMs`
 * (from a server `Retry-After`) wins, still capped. Pure — pass `jitter` for
 * deterministic tests (default randomizes in [0.9, 1.1]).
 */
export function reconnectBackoffMs(
  attempt: number,
  opts: { retryAfterMs?: number; baseMs?: number; capMs?: number; jitter?: number } = {},
): number {
  const cap = opts.capMs ?? RECONNECT_CAP_MS;
  if (typeof opts.retryAfterMs === 'number' && opts.retryAfterMs > 0) {
    return Math.min(cap, Math.round(opts.retryAfterMs));
  }
  const a = Math.max(1, Math.floor(attempt));
  const base = opts.baseMs ?? RECONNECT_BASE_MS;
  const raw = base * Math.pow(RECONNECT_FACTOR, a - 1);
  const jitter = opts.jitter ?? 0.9 + Math.random() * 0.2;
  return Math.min(cap, Math.round(raw * jitter));
}

/**
 * Parse an HTTP `Retry-After` header into milliseconds: either delta-seconds
 * (`"5"`) or an HTTP-date. Returns undefined when absent/unparseable; clamps a
 * past date to 0. Pure — pass `nowMs` for deterministic tests.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, nowMs?: number): number | undefined {
  if (!headerValue) return undefined;
  const v = String(headerValue).trim();
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10) * 1000;
  const when = Date.parse(v);
  if (!Number.isNaN(when)) return Math.max(0, when - (nowMs ?? Date.now()));
  return undefined;
}

/**
 * Best-effort connectivity probe to the request endpoint's origin: a bounded HEAD
 * that resolves true on ANY HTTP response (even 4xx — the server was reached) and
 * false only when the request can't connect at all. Local endpoints are always
 * "online". Bounded by `timeoutMs` (default 3s) so it never itself stalls.
 */
export async function probeConnectivity(endpoint: string, timeoutMs = 3000): Promise<boolean> {
  try {
    if (!endpoint || /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(endpoint)) return true;
    const origin = new URL(endpoint).origin;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(origin, { method: 'HEAD', signal: controller.signal });
      return true; // any response (incl. 4xx/5xx) means we reached the network
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false; // could not connect at all → treat as offline
  }
}

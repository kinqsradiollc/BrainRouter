export interface ExternalApiRetryOptions {
  label: string;
  maxRetries?: number;
  baseDelayMs?: number;
  /** Upper bound on any single backoff wait (also caps a huge server Retry-After). */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Deterministic jitter source for tests; defaults to Math.random. */
  random?: () => number;
}

export class ExternalApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    /** Set when the failure is a recoverable blip (status- or body-detected). */
    public readonly retryable: boolean = false,
    /** Server-requested wait before retrying (from a `Retry-After` header), in ms. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ExternalApiError";
  }
}

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const RETRYABLE_HTTP_STATUSES = new Set([429, 503]);

/**
 * Parse a `Retry-After` header into ms. GitHub / OpenAI-compatible gateways send
 * either delta-seconds (`"5"`) or an HTTP-date. Returns undefined when absent /
 * unparseable so the caller falls back to exponential backoff.
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const s = header.trim();
  if (/^\d+$/.test(s)) return Math.max(0, Number(s) * 1000);
  const at = Date.parse(s);
  if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  return undefined;
}

/**
 * Backoff for one attempt: exponential base with EQUAL JITTER (half fixed, half
 * random) so concurrent callers retrying the same overloaded endpoint don't
 * re-collide in lockstep. A server `Retry-After` (when present) takes precedence.
 * Everything is capped at `maxDelayMs`.
 */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfterMs: number | undefined,
  random: () => number,
): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  const jittered = exp / 2 + random() * (exp / 2);
  const withServerHint = retryAfterMs !== undefined ? Math.max(retryAfterMs, jittered) : jittered;
  return Math.min(maxDelayMs, Math.round(withServerHint));
}

// Statuses that must carry an empty body — passing text to `new Response()` with
// one of these throws, so we rebuild them with a null body.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

// Some OpenAI-compatible backends (notably LM Studio and proxying gateways) report
// a *transient* connection drop as an ordinary 4xx/5xx, with the real cause only in
// the body — e.g. `{"error":"LM Link connection closed."}`. Treating those as hard
// failures permanently drops a record's embedding (silent vector loss) and makes
// bulk imports look stalled while they spew errors. Retry when the body reads like a
// recoverable connection / availability blip rather than a real client error.
const TRANSIENT_BODY_PATTERN =
  /(connection (closed|reset|aborted|refused|lost|dropped)|connection was closed|socket hang ?up|broken pipe|stream (was )?(closed|disconnected|interrupted|ended)|econnreset|econnrefused|econnaborted|epipe|etimedout|read ?timed? ?out|temporarily unavailable|service unavailable|model (is )?(still )?loading|please try again|overloaded|try again later)/i;

/** True when a response body looks like a transient connection/availability blip. */
export function isTransientConnectionBody(body: string | undefined | null): boolean {
  return !!body && TRANSIENT_BODY_PATTERN.test(body);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableExternalError(error: unknown): boolean {
  if (error instanceof ExternalApiError) {
    if (error.retryable) return true;
    return error.status !== undefined && RETRYABLE_HTTP_STATUSES.has(error.status);
  }

  // Low-level fetch/network failures (DNS, socket reset, abort) surface as TypeError.
  if (error instanceof TypeError) {
    return true;
  }

  return false;
}

export async function retryExternalCall<T>(
  operation: () => Promise<T>,
  options: ExternalApiRetryOptions
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableExternalError(error)) {
        throw error;
      }

      // A 429/503 may carry a server-requested wait; honor it (capped), otherwise
      // fall back to jittered exponential backoff.
      const retryAfterMs = error instanceof ExternalApiError ? error.retryAfterMs : undefined;
      const delayMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs, retryAfterMs, random);
      attempt += 1;
      console.error(`[BrainRouter] ${options.label} failed with a retryable error. Retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries}).`);
      await sleep(delayMs);
    }
  }
}

export async function fetchWithExternalRetry(
  input: string | URL | Request,
  init: RequestInit,
  options: ExternalApiRetryOptions
): Promise<Response> {
  return retryExternalCall(async () => {
    const response = await fetch(input, init);
    if (response.ok) {
      return response;
    }

    // Non-ok: buffer the body once so we can both classify it and still hand a
    // readable Response back to the caller's error path (the body can only be
    // consumed once). OK responses are returned untouched above so streaming
    // and large payloads are unaffected.
    const bodyText = await response.text().catch(() => "");
    const transient = isTransientConnectionBody(bodyText);
    if (transient || RETRYABLE_HTTP_STATUSES.has(response.status)) {
      // Respect the provider's backpressure hint when it sends one (429/503 often do).
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      throw new ExternalApiError(
        `${options.label} failed with HTTP ${response.status} ${response.statusText}`
          + (transient ? " (transient connection drop)" : "")
          + (bodyText ? ` - ${bodyText.slice(0, 200)}` : ""),
        response.status,
        true,
        retryAfterMs,
      );
    }

    // Genuine, non-retryable error — rebuild a fresh Response carrying the
    // already-read body so callers can still `await res.text()` / read status.
    // Drop content-encoding/length headers: the body is now decoded text and the
    // original lengths no longer apply.
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    const safeBody = NULL_BODY_STATUSES.has(response.status) ? null : (bodyText || null);
    return new Response(safeBody, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }, options);
}

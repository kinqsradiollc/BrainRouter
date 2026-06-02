/**
 * API-RATELIMIT (0.4.9) — one reusable in-memory rate limiter.
 *
 * The server previously had a single inline limiter wired only to the two auth
 * routes (signin/signup). This generalizes that into a factory so the same
 * fixed-window-per-IP logic backs both the strict auth limit and a generous
 * global guard on the whole `/api` surface (a cheap brute-force / runaway-client
 * backstop). On overflow it returns a clean **429** with a `Retry-After` header
 * and the standard `{ error, code }` envelope.
 *
 * In-memory + per-process (matches the existing design): fine for a single brain
 * instance; a multi-replica deployment would swap the store for a shared one. The
 * clock is injectable so the window logic unit-tests deterministically.
 */

import type { Request, Response, NextFunction } from "express";

export interface RateLimitOptions {
  /** Rolling window length in ms. */
  windowMs: number;
  /** Max requests permitted per key per window. `0` disables the limiter (no-op). */
  max: number;
  /** Response message on overflow. */
  message?: string;
  /** Machine code in the JSON envelope. */
  code?: string;
  /** Key derivation; defaults to client IP. */
  keyGenerator?: (req: Request) => string;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Build an Express middleware enforcing `max` requests per `windowMs` per key.
 * `max <= 0` returns a pass-through (lets a deployment disable the global limiter
 * via config without branching at the call site).
 */
export function createRateLimiter(options: RateLimitOptions) {
  const { windowMs, max } = options;
  const message = options.message ?? "Too many requests";
  const code = options.code ?? "rate_limited";
  const keyOf = options.keyGenerator ?? ((req: Request) => req.ip ?? "unknown");
  const clock = options.now ?? (() => Date.now());

  if (max <= 0) {
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }

  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = clock();
    const key = keyOf(req);
    const existing = buckets.get(key);
    const bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);

    // Opportunistic sweep so the map can't grow unbounded from one-off IPs.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    }

    if (bucket.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({ error: message, code });
      return;
    }
    next();
  };
}

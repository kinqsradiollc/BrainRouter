/**
 * API-HEADERS-CORS (0.4.9) — security response headers + a strict CORS allowlist.
 *
 * The previous CORS middleware compared the request Origin to a single env value
 * and set no security headers. This module:
 *   - accepts a comma-separated `BRAINROUTER_CORS_ORIGIN` allowlist (multi-origin),
 *   - reflects ONLY an allowed Origin and sends credentials only then,
 *   - applies the standard hardening headers (nosniff, frame-deny, referrer,
 *     permissions-policy, clickjacking CSP, HSTS in production).
 *
 * Pure helpers (`resolveCorsAllowlist`, `isOriginAllowed`) unit-test cleanly.
 */

import type { Request, Response, NextFunction } from "express";

const DEFAULT_CORS_ORIGIN = "http://localhost:3000";

/** Parse `BRAINROUTER_CORS_ORIGIN` into an allowlist (comma-separated). */
export function resolveCorsAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.BRAINROUTER_CORS_ORIGIN?.trim();
  if (!raw) return [DEFAULT_CORS_ORIGIN];
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

/** A local dev origin: http(s)://localhost or 127.0.0.1 on any port. */
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/**
 * True when `origin` is explicitly allowlisted (or the allowlist is `*`). When
 * `devPermissive` is set (non-production), ANY localhost / 127.0.0.1 origin is
 * allowed too — so a dashboard on any local port "just works" in dev without
 * pinning BRAINROUTER_CORS_ORIGIN. Production is unaffected (explicit allowlist).
 */
export function isOriginAllowed(origin: string | undefined, allowlist: string[], devPermissive = false): boolean {
  if (!origin) return false;
  if (allowlist.includes("*") || allowlist.includes(origin)) return true;
  if (devPermissive && LOCALHOST_ORIGIN_RE.test(origin)) return true;
  return false;
}

/**
 * CORS: reflect only an allowed Origin (credentials only then). Same-origin /
 * no-Origin requests (curl, server-to-server, the MCP client) pass through; a
 * disallowed cross-origin preflight is rejected 403. In non-production any
 * localhost origin is allowed (see isOriginAllowed).
 */
export function corsMiddleware(allowlist: string[] = resolveCorsAllowlist(), opts: { production?: boolean } = {}) {
  const devPermissive = !(opts.production ?? process.env.NODE_ENV === "production");
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    const allowed = isOriginAllowed(origin, allowlist, devPermissive);
    res.setHeader("Vary", "Origin");
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin!);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, X-BrainRouter-Org, X-BrainRouter-Session");
    if (req.method === "OPTIONS") {
      res.sendStatus(allowed || !origin ? 204 : 403);
      return;
    }
    next();
  };
}

/**
 * Standard security headers on every response. No CSP `default-src` (would break
 * the optionally server-served dashboard static); `frame-ancestors 'none'` covers
 * clickjacking. HSTS only in production (HTTPS).
 */
export function securityHeaders(opts: { production?: boolean } = {}) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    if (opts.production) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  };
}

/**
 * BRAIN-BODY-LIMIT (0.4.8) — JSON request-body size policy for the HTTP server.
 *
 * The server mounts `express.json()` globally. With no `limit`, body-parser
 * enforces its stock **100 kB** default on every route — and a large MCP
 * JSON-RPC payload (a `memory_capture_turn` with a big transcript, a multi-record
 * recall/sync, focus-scene distillation input) blows past it and throws an
 * *unhandled* `PayloadTooLargeError`, surfacing as a 500/crash with a raw stack.
 *
 * This module supplies (a) a configurable limit sized for real MCP payloads and
 * (b) an error middleware that turns the overflow into a clean **413** instead of
 * an unhandled throw. The limit is a server setting, read from the environment
 * (the brain server's convention — distinct from the CLI's `cli.*` config knobs).
 */

import type { Request, Response, NextFunction } from "express";

/**
 * Default max JSON body the brain HTTP server accepts. Sized well above
 * body-parser's 100 kB stock default so ordinary MCP tool payloads (capture
 * transcripts, multi-record recall/sync) don't trip it, while still bounding a
 * runaway request. Override with `BRAINROUTER_MAX_BODY_SIZE` (any byte string
 * `express.json` accepts, e.g. `"32mb"`).
 */
export const DEFAULT_JSON_BODY_LIMIT = "16mb";

/**
 * Resolve the configured JSON body limit. Server-side setting (env), NOT a
 * `cli.*` knob. Empty/whitespace env falls back to the default.
 */
export function resolveJsonBodyLimit(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BRAINROUTER_MAX_BODY_SIZE?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_JSON_BODY_LIMIT;
}

/**
 * True when an Express/body-parser error is the "payload too large" case.
 * body-parser sets `type: "entity.too.large"` and `status/statusCode: 413`.
 */
export function isPayloadTooLarge(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown };
  return e.type === "entity.too.large" || e.status === 413 || e.statusCode === 413;
}

/**
 * Express error middleware: map a `PayloadTooLargeError` to a clean **413** JSON
 * response (so the process stays up and the client gets an actionable message)
 * and pass every other error through untouched. Register AFTER the routes; a
 * body-parser parse error propagates here regardless of where it was thrown.
 */
export function payloadTooLargeHandler(limit: string) {
  return (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (isPayloadTooLarge(err)) {
      // Guard against a double-send if headers already went out.
      if (res.headersSent) {
        next(err as Error);
        return;
      }
      res.status(413).json({
        error: "Request entity too large",
        limit,
        hint: `JSON body exceeds the ${limit} limit. Reduce the payload (e.g. chunk/offload large transcripts) or raise BRAINROUTER_MAX_BODY_SIZE.`,
      });
      return;
    }
    next(err as Error);
  };
}

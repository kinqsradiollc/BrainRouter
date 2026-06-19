/**
 * API-ERRORS (0.4.9) — one terminal error-handling middleware.
 *
 * Routes previously each shaped their own failure responses (some `{ error }`,
 * some bare strings, some let an exception bubble to Express's default handler
 * which leaks a raw HTML stack trace). This is the single 4-arg handler mounted
 * LAST: it maps known error shapes to the right status and emits one consistent
 * `{ error, code }` envelope, and — critically — never leaks an internal stack or
 * message to clients in production (a generic 500 instead). 5xx are logged
 * server-side for observability; 4xx (client faults) are not, to keep logs clean.
 *
 * Specific upstream handlers still run first (e.g. the 413 payload handler); only
 * what they pass through via `next(err)` reaches here.
 */

import type { Request, Response, NextFunction } from "express";
import { codeForStatus, statusForError } from "../../contracts/http.js";

// The status→code map and status resolver are the wire contract — they live in
// `contracts/http.js` so routes, middleware, and the terminal handler agree on
// one envelope. Re-exported here for the established import path.
export { codeForStatus, statusForError };

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  issues?: unknown;
  stack?: unknown;
}

export interface ErrorHandlerOptions {
  /** When true, never echo internal 5xx messages/stacks to the client. */
  production?: boolean;
  /** Injectable sink for server-side error logging (defaults to console.error). */
  logger?: (line: string, err?: unknown) => void;
}

/**
 * Build the terminal Express error handler. Register AFTER all routes and after
 * any specific error handlers (e.g. the 413 payload handler).
 */
export function errorHandler(options: ErrorHandlerOptions = {}) {
  const isProd = options.production ?? false;
  const log = options.logger ?? ((line: string, err?: unknown) => console.error(line, err));

  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    // If a response already started streaming, we can't rewrite it — let Express abort.
    if (res.headersSent) {
      next(err as Error);
      return;
    }

    const status = statusForError(err);
    const e = (err ?? {}) as ErrorLike;
    const code = typeof e.code === "string" && e.code.length > 0 ? e.code : codeForStatus(status);

    if (status >= 500) {
      log(`[api-error] ${req.method} ${req.originalUrl} -> ${status}`, err);
    }

    const body: { error: string; code: string; details?: unknown } = {
      error: "Internal server error",
      code,
    };

    if (status < 500) {
      // Client faults: a clear message is safe and useful.
      body.error = typeof e.message === "string" && e.message.length > 0 ? e.message : codeForStatus(status);
      if (e.name === "ZodError" && Array.isArray(e.issues)) {
        body.details = (e.issues as Array<{ path?: unknown[]; message?: unknown }>).map((i) => ({
          path: Array.isArray(i.path) ? i.path.join(".") : "",
          message: typeof i.message === "string" ? i.message : "Invalid value",
        }));
      }
    } else if (!isProd) {
      // Server faults in dev: surface the message (and stack) to speed debugging.
      if (typeof e.message === "string" && e.message.length > 0) body.error = e.message;
      if (typeof e.stack === "string") body.details = e.stack;
    }

    res.status(status).json(body);
  };
}

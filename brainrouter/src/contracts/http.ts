/**
 * ADR-004 Phase 1 — HTTP wire contracts.
 *
 * The single source of truth for the API's error envelope. Every failure
 * response — whether shaped by the terminal {@link errorHandler}, a middleware
 * (rate-limit), or an inline route guard via {@link sendError} — emits the same
 * `{ error, code, details? }` body, and the status→code mapping lives here once.
 *
 * This is a contract module: no Express app wiring, no engine imports — just the
 * wire shape + pure helpers, so it stays trivially testable and importable from
 * routes, middleware, and (later) tools without a dependency cycle.
 */

import type { Response } from "express";

/** The canonical API error response body. */
export interface ApiErrorBody {
  /** Human-readable message (safe to surface to clients for 4xx). */
  error: string;
  /** Stable machine code, e.g. `not_found` — see {@link codeForStatus}. */
  code: string;
  /** Optional structured detail (Zod field issues, a dev-only stack, …). */
  details?: unknown;
}

/** Stable machine codes the envelope emits, keyed by the statuses we return. */
export const ERROR_CODES = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
} as const;

/** Map an HTTP status to a stable machine code for the envelope. */
export function codeForStatus(status: number): string {
  const known = (ERROR_CODES as Record<number, string>)[status];
  if (known) return known;
  return status >= 500 ? "internal_error" : "error";
}

interface ErrorLike {
  name?: unknown;
  status?: unknown;
  statusCode?: unknown;
}

/** Resolve the HTTP status an arbitrary thrown error should map to. */
export function statusForError(err: unknown): number {
  const e = (err ?? {}) as ErrorLike;
  if (e.name === "ZodError") return 400;
  if (e.name === "ScopeError") return 403;
  const raw = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
  if (typeof raw === "number" && raw >= 400 && raw <= 599) return raw;
  return 500;
}

/**
 * Emit the standard error envelope from an inline route guard. Replaces the
 * hand-rolled `res.status(n).json({ error })` sites so every error response
 * carries a machine `code` consistent with the terminal handler. Returns the
 * `Response` so callers may `return sendError(...)`.
 */
export function sendError(res: Response, status: number, message: string, details?: unknown): Response {
  const body: ApiErrorBody = { error: message, code: codeForStatus(status) };
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

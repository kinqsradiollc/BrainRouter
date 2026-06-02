/**
 * API-VALIDATE (0.4.9) — one reusable request-validation middleware.
 *
 * Routes previously validated ad-hoc (per-route `typeof` checks + `String()`
 * coercion + shared `PaginationQuerySchema`), with inconsistent rejection. This
 * centralizes it: a zod schema per request part; on failure a single **400** with
 * structured field errors; on success the parsed (typed, unknown-stripped) value
 * is attached to `req.valid[part]` (we do NOT reassign `req.query`/`req.params`,
 * which are read-only getters in Express 5).
 *
 * Pure-ish (only touches req/res) so it unit-tests with a real express app.
 */

import type { Request, Response, NextFunction } from "express";
import type { ZodTypeAny } from "zod";

export interface ValidateSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export type ValidatedRequest = Request & {
  valid?: { body?: unknown; query?: unknown; params?: unknown };
};

export function validate(schemas: ValidateSchemas) {
  return (req: ValidatedRequest, res: Response, next: NextFunction): void => {
    const parts = ["params", "query", "body"] as const;
    for (const part of parts) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse((req as unknown as Record<string, unknown>)[part] ?? {});
      if (!result.success) {
        res.status(400).json({
          error: "Invalid request",
          code: "validation_error",
          details: result.error.issues.map((i) => ({
            path: i.path.join(".") || part,
            message: i.message,
          })),
        });
        return;
      }
      req.valid = req.valid ?? {};
      req.valid[part] = result.data;
    }
    next();
  };
}

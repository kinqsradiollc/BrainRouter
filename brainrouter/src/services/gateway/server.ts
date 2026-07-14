/** Hosted model-gateway HTTP boundary. Upstream credentials never cross it. */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { GatewayAuthError, type GatewayAuthContext } from "./auth.js";
import {
  registerGatewayDataPlane,
  sendOpenAiError,
  type GatewayDataPlaneOptions,
  type GatewayDataPlaneService,
} from "./chatRoutes.js";

export interface GatewayHttpService extends GatewayDataPlaneService {
  ping(): Promise<boolean>;
  authenticate(bearer: string, requestedOrgId?: string): Promise<GatewayAuthContext>;
}

export interface GatewayAppOptions extends GatewayDataPlaneOptions {
  requestId?: () => string;
}

function generatedRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "")}`;
}

function bearer(req: Request): string {
  const value = req.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

export function createGatewayApp(svc: GatewayHttpService, options: GatewayAppOptions = {}) {
  const app = express();
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const candidate = options.requestId?.() ?? generatedRequestId();
    const id = /^req_[A-Za-z0-9_-]{1,100}$/.test(candidate) ? candidate : generatedRequestId();
    res.locals.requestId = id;
    res.setHeader("x-request-id", id);
    next();
  });
  app.use(express.json({ limit: "256kb" }));

  // Health is unauthenticated (liveness/readiness probes).
  app.get("/health", async (_req: Request, res: Response) => {
    const db = await svc.ping();
    res.json({ status: db ? "ok" : "degraded", service: "provider-gateway", db });
  });

  // All data-plane routes derive identity and tenant scope here. A body orgId is
  // never observed; an optional header merely selects among current memberships.
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const requested = req.headers["x-brainrouter-org"];
    try {
      res.locals.gatewayAuth = await svc.authenticate(
        bearer(req),
        typeof requested === "string" ? requested : undefined,
      );
      next();
    } catch (error) {
      if (error instanceof GatewayAuthError) {
        sendOpenAiError(res, error.status, {
          message: error.message,
          type: "authentication_error",
          param: null,
          code: error.code,
        });
        return;
      }
      sendOpenAiError(res, 401, {
        message: "The access credential is not valid.",
        type: "authentication_error",
        param: null,
        code: "invalid_credential",
      });
    }
  });

  registerGatewayDataPlane(app, svc, options);

  // /v1/resolve intentionally no longer exists. Data-plane routes consume
  // res.locals.gatewayAuth and keep decrypted upstream custody in-process.
  app.use((_req: Request, res: Response) => {
    sendOpenAiError(res, 404, {
      message: "Unknown route.",
      type: "not_found_error",
      param: null,
      code: null,
    });
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const kind = typeof error === "object" && error !== null && "type" in error
      ? String((error as { type?: unknown }).type ?? "")
      : "";
    if (kind === "entity.too.large") {
      sendOpenAiError(res, 413, {
        message: "The request body is too large.",
        type: "invalid_request_error",
        param: null,
        code: "request_too_large",
      });
      return;
    }
    if (error instanceof SyntaxError) {
      sendOpenAiError(res, 400, {
        message: "The request body is not valid JSON.",
        type: "invalid_request_error",
        param: null,
        code: "invalid_json",
      });
      return;
    }
    sendOpenAiError(res, 500, {
      message: "BrainRouter could not complete the request.",
      type: "api_error",
      param: null,
      code: "internal_error",
    });
  });

  return app;
}

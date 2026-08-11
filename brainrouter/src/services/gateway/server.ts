/** Hosted model-gateway HTTP boundary. Upstream credentials never cross it. */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express, { type Request, type Response, type NextFunction } from "express";
import {
  corsMiddleware,
  resolveCorsAllowlist,
  securityHeaders,
} from "../../api/middleware/securityHeaders.js";
import { GatewayAuthError, type GatewayAuthContext } from "./auth.js";
import {
  registerGatewayDataPlane,
  sendOpenAiError,
  type GatewayDataPlaneOptions,
  type GatewayDataPlaneService,
} from "./chatRoutes.js";
import { createGatewayAudioStreamingPort } from "./audio-streaming-adapter.js";
import { registerGatewayAudioCapabilities } from "./audio-capabilities.js";
import { registerGatewayAudioPlane } from "./audioRoutes.js";
import {
  attachGatewayAudioStreamingPlane,
  type GatewayAudioStreamingController,
  type GatewayAudioStreamingOptions,
} from "./audio-streaming-server.js";

export interface GatewayHttpService extends GatewayDataPlaneService {
  ping(): Promise<boolean>;
  authenticate(bearer: string, requestedOrgId?: string): Promise<GatewayAuthContext>;
}

export interface GatewayAppOptions extends GatewayDataPlaneOptions {
  requestId?: () => string;
  audioStreaming?: GatewayAudioStreamingOptions;
}

export interface GatewayServer {
  readonly app: import("express").Express;
  readonly server: Server;
  readonly audioStreaming: GatewayAudioStreamingController;
}

function generatedRequestId(): string {
  return `req_${randomUUID().replace(/-/g, "")}`;
}

function bearer(req: Request): string {
  const value = req.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

/** Stamp a validated x-request-id (shared by the standalone app and the mount). */
function requestIdMiddleware(options: GatewayAppOptions) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const candidate = options.requestId?.() ?? generatedRequestId();
    const id = /^req_[A-Za-z0-9_-]{1,100}$/.test(candidate) ? candidate : generatedRequestId();
    res.locals.requestId = id;
    res.setHeader("x-request-id", id);
    next();
  };
}

/**
 * Derive identity + tenant scope onto res.locals.gatewayAuth. A body orgId is
 * never observed; an optional X-BrainRouter-Org header selects among current
 * memberships. Gateway auth is DISTINCT from the brain's /api JWT: it accepts a
 * `br_` API key or a JWT with aud=brainrouter-model-gateway + scope models:invoke.
 */
function gatewayAuthMiddleware(svc: Pick<GatewayHttpService, "authenticate">) {
  return async (req: Request, res: Response, next: NextFunction) => {
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
  };
}

function capturedOptions(options: GatewayAppOptions, includeStreamingPort: boolean): GatewayAppOptions {
  const mutableAudioStreaming: {
    -readonly [Key in keyof GatewayAudioStreamingOptions]: GatewayAudioStreamingOptions[Key]
  } = {
    ...(options.audioStreaming ?? {}),
    production: options.audioStreaming?.production ?? (process.env.NODE_ENV === "production"),
    ...(options.audioStreaming?.allowedOrigins
      ? { allowedOrigins: Object.freeze([...options.audioStreaming.allowedOrigins]) }
      : {}),
  };
  if (!includeStreamingPort) delete mutableAudioStreaming.port;
  const audioStreaming = Object.freeze(mutableAudioStreaming);
  return Object.freeze({ ...options, audioStreaming });
}

function registerGatewayHttpDataPlane(
  app: import("express").Express,
  svc: GatewayHttpService,
  options: GatewayAppOptions,
): void {
  const origins = [...(options.audioStreaming?.allowedOrigins ?? resolveCorsAllowlist())];
  const production = options.audioStreaming?.production;
  app.use(
    "/v1",
    securityHeaders({ production }),
    corsMiddleware(origins, { production }),
    requestIdMiddleware(options),
    gatewayAuthMiddleware(svc),
  );
  registerGatewayDataPlane(app, svc, options);
  registerGatewayAudioCapabilities(app, options.audioStreaming?.port);
  registerGatewayAudioPlane(app, svc);
}

/**
 * Mount the OpenAI-compatible HTTP routes onto an existing Express app. New
 * production callers should use `bindGatewayDataPlane` so HTTP capability
 * discovery and WebSocket admission capture one immutable configuration.
 */
export function mountGatewayDataPlane(
  app: import("express").Express,
  svc: GatewayHttpService,
  options: GatewayAppOptions = {},
): void {
  registerGatewayHttpDataPlane(app, svc, capturedOptions(options, false));
}

/**
 * Bind both gateway data planes from one immutable option snapshot.
 *
 * This is where ADR-035 D10's adapter seam is filled. An explicitly passed port
 * always wins; otherwise the environment decides, and with
 * `BRAINROUTER_STT_STREAM_URL` unset that is `undefined` — capabilities keep
 * advertising `streaming: null`, the upgrade keeps answering 503, and the batch
 * POST is untouched. Only a BOUND plane may hold a port: an HTTP-only mount has
 * no WebSocket to serve, so `capturedOptions` drops it there rather than letting
 * one advertise a live path it cannot honour.
 */
export function bindGatewayDataPlane(
  app: import("express").Express,
  server: Server,
  svc: GatewayHttpService,
  options: GatewayAppOptions = {},
): GatewayAudioStreamingController {
  const port = options.audioStreaming?.port ?? createGatewayAudioStreamingPort() ?? undefined;
  const captured = capturedOptions(
    { ...options, audioStreaming: { ...options.audioStreaming, ...(port ? { port } : {}) } },
    true,
  );
  registerGatewayHttpDataPlane(app, svc, captured);
  return attachGatewayAudioStreamingPlane(server, svc, captured.audioStreaming);
}

function createGatewayBaseApp(svc: GatewayHttpService) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // Health is unauthenticated (liveness/readiness probes).
  app.get("/health", async (_req: Request, res: Response) => {
    const db = await svc.ping();
    res.json({ status: db ? "ok" : "degraded", service: "provider-gateway", db });
  });

  return app;
}

function registerGatewayTerminalHandlers(app: import("express").Express): void {
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
}

export function createGatewayApp(svc: GatewayHttpService, options: GatewayAppOptions = {}) {
  const app = createGatewayBaseApp(svc);
  mountGatewayDataPlane(app, svc, options);
  registerGatewayTerminalHandlers(app);

  return app;
}

/** Create an unlistened standalone server with one HTTP/WebSocket binding. */
export function createGatewayServer(svc: GatewayHttpService, options: GatewayAppOptions = {}): GatewayServer {
  const app = createGatewayBaseApp(svc);
  const server = createServer(app);
  const audioStreaming = bindGatewayDataPlane(app, server, svc, options);
  registerGatewayTerminalHandlers(app);
  return { app, server, audioStreaming };
}

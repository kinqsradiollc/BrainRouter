#!/usr/bin/env node
// ─────────────────────────────────────────────
// BrainRouter MCP Server — Entry Point
// ─────────────────────────────────────────────
//
// Supports two transport modes:
//
//   stdio (default)
//     The AI tool spawns this process and communicates via stdin/stdout.
//     No URL, no port. Tool manages the lifecycle.
//     Usage: node dist/index.js --root /path/to/project
//
//   HTTP (--http flag)
//     Runs an Express HTTP server. Connect via serverUrl in tool config.
//     Usage: node dist/index.js --root /path/to/project --http --port 3747
//
//   init subcommand
//     Scaffold ~/.config/brainrouter/server.env from the bundled
//     .env.example and exit. Run this once after a global install.
//     Usage: brainrouter-mcp init
//

// CRITICAL: import order matters. `init` may exit the process before
// anything else loads (for `brainrouter-mcp init`). `env-loader` runs next
// and sets process.env from the right .env file before any module body
// reads env vars (sqlite/embedding/extractor all do at load time).
import './init.js';
import './env-loader.js';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import fs from "node:fs";

import { Registry } from './registry.js';
import { resolveRegistryConfig } from './resolver.js';
import { buildMcpServer } from './transport/mcpServer.js';
import {
  matchesMcpSessionIdentity,
  type McpSessionIdentity,
} from './transport/mcpSessionIdentity.js';
import { recordHttp, routeBucket, renderPrometheus, metricsSnapshot } from './observability/metrics.js';
import { collectSystemStatus } from './observability/status.js';
import { modelGateway } from './services/modelGateway/modelGateway.js';

import { memoryEngine, closeMemoryEngine } from './memory/engine.js';
import { resolveOrgContext } from './tenancy/context.js';
import path from 'node:path';
import { decideMcpAcceptPromotion } from './api/mcpAcceptHeader.js';
import { authRouter, usersRouter, sessionsRouter } from './api/routes/identity/index.js';
import { meetingsRouter, publicMeetingsRouter } from './api/routes/meetings.js';
import { trackRouter } from './api/routes/track.js';
import { plannerRouter } from './api/routes/planner.js';
import { notesRouter } from './api/routes/notes.js';
import { workspaceRouter } from './api/routes/workspace.js';
import { teamsRouter } from './api/routes/teams.js';
import { chatThreadsRouter } from './api/routes/chatThreads.js';
import { publicSharePageRouter } from './api/routes/publicShare.js';
import { vulnerabilitiesRouter } from './api/routes/vulnerabilities.js';
import { orgsRouter, projectsRouter, githubReposRouter } from './api/routes/tenancy/index.js';
import { connectorOauthRouter } from './api/routes/connectors/oauth.js';
import { connectorManageRouter } from './api/routes/connectors/manage.js';
import { githubConnectorRouter, githubConnectorAdminRouter } from './api/routes/connectors/github.js';
import { providersRouter, agentModelsRouter, recallSettingsRouter, integrationsRouter, reviewsRouter, pentestsRouter, adminEmailRouter, adminOrgsRouter, adminModelsRouter } from './api/routes/admin/index.js';
import { modelsRouter } from './api/routes/models/index.js';
import { remoteRouter } from './api/routes/remote/index.js';
import {
  knowledgeBasesRouter,
  knowledgeDistillationRouter,
  knowledgeDocumentsRouter,
  knowledgeSearchRouter,
} from './api/routes/knowledge/index.js';
import { triggersRouter } from './api/routes/triggers/index.js';
import {
  memoriesRouter,
  contradictionsRouter,
  evidenceRouter,
  graphRouter,
  scenesRouter,
  personaRouter,
  statsRouter,
  skillsRouter,
  workingRouter,
} from './api/routes/memory/index.js';
import { brainRouter, fleetRouter, hooksRouter, governanceRouter } from './api/routes/agent/index.js';
import { USING_FALLBACK_JWT_SECRET, IS_PRODUCTION, jwtSecretBootError, JWT_SECRET } from './api/middleware/auth.js';
import { GatewayProviderService } from './services/gateway/providerPool.js';
import { mountGatewayDataPlane } from './services/gateway/server.js';
import { securityHeaders, corsMiddleware, resolveCorsAllowlist } from './api/middleware/securityHeaders.js';
import { resolveJsonBodyLimit, payloadTooLargeHandler } from './api/bodyLimit.js';
import { createRateLimiter } from './api/middleware/rateLimit.js';
import { errorHandler } from './api/middleware/errorHandler.js';

// Strict limiter for the credential endpoints — brute-force backstop.
const authRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many authentication attempts",
});

// Generous global limiter across the whole /api surface (runaway-client backstop).
// Sized well above normal dashboard polling; tune or disable (max=0) via env.
const GLOBAL_RATE_LIMIT_MAX = Number.parseInt(process.env.BRAINROUTER_RATE_LIMIT_MAX ?? "600", 10);
const GLOBAL_RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.BRAINROUTER_RATE_LIMIT_WINDOW_MS ?? "60000", 10);
const apiRateLimit = createRateLimiter({
  windowMs: Number.isFinite(GLOBAL_RATE_LIMIT_WINDOW_MS) ? GLOBAL_RATE_LIMIT_WINDOW_MS : 60_000,
  max: Number.isFinite(GLOBAL_RATE_LIMIT_MAX) ? GLOBAL_RATE_LIMIT_MAX : 600,
});

// ─── CLI flags ────────────────────────────────────────────────────────────────
function parseFlag(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
}

const USE_HTTP = process.argv.includes('--http');
const PORT = parseInt(parseFlag('--port') ?? '3747', 10);

// ─── Bootstrap ────────────────────────────────────────────────────────────────
const config = resolveRegistryConfig();
const registry = new Registry(config);
registry.build();

// ADR-007 Phase 2 (step 3) — the memory engine runs on Postgres, whose init
// (migrations + vector table + seed-admin) is genuinely async. Await it BEFORE
// the first store-using call (skill-hint scan, auth lookups, app.listen / stdio
// connect) so we never serve against an un-migrated database.
await memoryEngine.ready;

// Auto-scan skills dirs for memory_hints on startup
const skillsDirsToScan = [
  path.join(config.globalRoot, 'skills'),
  config.localRoot ? path.join(config.localRoot, 'skills') : undefined,
].filter((d): d is string => !!d); // remove undefined and deduplicate
const uniqueSkillsDirs = [...new Set(skillsDirsToScan)];
memoryEngine.autoScanSkillHints(uniqueSkillsDirs);

if (USE_HTTP) {
  // ── HTTP / Streamable-HTTP transport ────────────────────────────────────────
  // Each client session gets its own Server + Transport instance.
  const sessions = new Map<string, {
    server: Server;
    transport: StreamableHTTPServerTransport;
    identity: McpSessionIdentity;
  }>();
  // Tracks which User-Agents we've already warned about for missing
  // `text/event-stream` in their Accept header — one warning per UA
  // so a chatty client doesn't drown the logs.
  const warnedUserAgents = new Set<string>();

  const app = express();

  // OBSERVABILITY (Phase 4) — time every request and record HTTP metrics on
  // finish (always on, cheap + in-process). Opt-in structured access log via
  // BRAINROUTER_HTTP_LOG=on (off by default to keep the server quiet).
  const httpAccessLog = process.env.BRAINROUTER_HTTP_LOG === "on";
  app.use((req: Request, res: Response, next: () => void) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - startedAt;
      const route = routeBucket(req.method, req.path);
      recordHttp(route, res.statusCode, ms);
      if (httpAccessLog) {
        console.error(JSON.stringify({ t: new Date().toISOString(), lvl: "info", msg: "http", route, status: res.statusCode, ms }));
      }
    });
    next();
  });

  // API-HEADERS-CORS (0.4.9) — security headers + a strict CORS allowlist.
  // BRAINROUTER_CORS_ORIGIN may be a comma-separated list; only listed origins
  // are reflected and only they receive credentials.
  app.use(securityHeaders({ production: IS_PRODUCTION }));
  // In dev, any localhost origin is allowed so the dashboard "just works"; in
  // production only BRAINROUTER_CORS_ORIGIN is reflected.
  app.use(corsMiddleware(resolveCorsAllowlist(), { production: IS_PRODUCTION }));

  // BRAIN-BODY-LIMIT — size the JSON body limit for real MCP payloads (capture
  // transcripts, multi-record recall/sync). body-parser's stock 100kb default
  // rejected large but legitimate requests; override via BRAINROUTER_MAX_BODY_SIZE.
  const jsonBodyLimit = resolveJsonBodyLimit();
  // ADR-010 P6b — stash the raw bytes so the GitHub webhook ingress can verify
  // the X-Hub-Signature-256 HMAC over the exact payload (re-serialized JSON
  // wouldn't byte-match). Cheap: one Buffer reference per request.
  app.use(express.json({
    limit: jsonBodyLimit,
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => { req.rawBody = buf; },
  }));
  // API-AUTHN (0.4.9) — fail closed in production if no JWT secret is configured.
  const jwtBootErr = jwtSecretBootError(IS_PRODUCTION, USING_FALLBACK_JWT_SECRET);
  if (jwtBootErr) {
    console.error(`[BrainRouter] FATAL: ${jwtBootErr}`);
    throw new Error(jwtBootErr);
  }
  if (USING_FALLBACK_JWT_SECRET) {
    console.error("[BrainRouter] WARNING: running with generated JWT secret. Set BRAINROUTER_JWT_SECRET in production.");
  }

  // Metrics — Prometheus text (default) or JSON (`?format=json` / Accept: json).
  // Gated behind BRAINROUTER_METRICS=on (404 when off) so a publicly-exposed
  // brain doesn't leak usage counts; operators enable it behind their scraper.
  if (process.env.BRAINROUTER_METRICS === "on") {
    app.get('/metrics', (req: Request, res: Response) => {
      const wantsJson = req.query.format === "json" || (req.headers.accept ?? "").includes("application/json");
      if (wantsJson) { res.json(metricsSnapshot()); return; }
      res.type("text/plain; version=0.0.4").send(renderPrometheus());
    });
  }

  // ADR-013 — this process's role. `brain` (default) serves BOTH the MCP tool
  // plane AND the REST/auth API (single-node, unchanged). Decompose a fleet by
  // running `mcp` (the memory/agent brain — MCP only) and `api` (auth + REST API
  // — no MCP) as separate services; each still boots the shared engine + DB.
  const SERVICE = (process.env.BRAINROUTER_SERVICE ?? "brain").toLowerCase();
  const serveRest = SERVICE === "brain" || SERVICE === "api";
  const serveMcp = SERVICE === "brain" || SERVICE === "mcp";
  // SINGLE GATEWAY — front the OpenAI-compatible /v1 model-gateway on THIS port so
  // clients (desktop BrainRouter provider, CLI, any OpenAI-compat caller) only ever
  // need :3747. Default ON for the single-node `brain`; OFF for the decomposed
  // stack (SERVICE=mcp/api) where a dedicated gateway container serves :3748 — set
  // BRAINROUTER_INPROCESS_GATEWAY=on to force it, =off to opt a brain out.
  const serveGateway = process.env.BRAINROUTER_INPROCESS_GATEWAY === "on"
    || (SERVICE === "brain" && process.env.BRAINROUTER_INPROCESS_GATEWAY !== "off");

  // Health check (fast liveness probe).
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: 'http', service: SERVICE, root: config.localRoot });
  });

  // Public status aggregation for the single gateway — reports the health of every
  // component (gateway / REST / MCP / database / memory). Unauthenticated + not
  // rate-limited (mounted before the /api throttle) so a status page or external
  // monitor can poll it. 503 when any component is down.
  app.get('/api/status', async (_req: Request, res: Response) => {
    const status = await collectSystemStatus({
      service: SERVICE,
      serveRest,
      serveMcp,
      pingDb: () => memoryEngine.ping(),
      uptimeSec: Math.round(process.uptime()),
      checkedAt: new Date().toISOString(),
      modelKinds: modelGateway.snapshot(),
    });
    res.status(status.status === 'down' ? 503 : 200).json(status);
  });

  // SINGLE-GATEWAY MOUNT — the OpenAI-compatible /v1 surface (chat/completions,
  // responses, models) on this same port, so :3747 is the one door clients need.
  // Auth here is the gateway's own (a `br_` API key or a models:invoke JWT — NOT
  // the plain /api JWT); it shares the brain's JWT_SECRET + Postgres so a token
  // minted by /api/auth validates here. Skipped (falls back to the standalone
  // :3748 gateway) when no database URL is configured.
  if (serveGateway) {
    const gatewayDbUrl = process.env.BRAINROUTER_DATABASE_URL ?? process.env.DATABASE_URL;
    if (gatewayDbUrl) {
      const gatewayService = new GatewayProviderService(gatewayDbUrl, JWT_SECRET);
      app.use('/v1', apiRateLimit);
      mountGatewayDataPlane(app, gatewayService);
      // Point internal scoped dispatch (dashboard brain-chat) at THIS in-process
      // gateway (base URL — modelGateway appends /v1/chat/completions) so a
      // single-node deploy needs no separate :3748 process.
      if (!process.env.BRAINROUTER_MODEL_GATEWAY_URL) {
        process.env.BRAINROUTER_MODEL_GATEWAY_URL = `http://127.0.0.1:${PORT}`;
      }
      console.error(`[BrainRouter] in-process model gateway mounted at /v1 (single-port ${SERVICE}).`);
    } else {
      console.error('[BrainRouter] in-process /v1 gateway skipped: no BRAINROUTER_DATABASE_URL; use the standalone gateway service.');
    }
  }

  if (serveRest) {
  app.use("/api", apiRateLimit);
  app.use("/api/auth/signin", authRateLimit);
  app.use("/api/auth/signup", authRateLimit);
  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/orgs", orgsRouter);
  app.use("/api/orgs", projectsRouter);
  app.use("/api/orgs", githubReposRouter);
  app.use("/api/connectors", githubConnectorRouter);
  app.use("/api/admin/connectors", githubConnectorAdminRouter);
  app.use("/api/admin/providers", providersRouter);
  app.use("/api/admin/models", adminModelsRouter);
  app.use("/api/models", modelsRouter);
  app.use("/api/knowledge", knowledgeBasesRouter);
  app.use("/api/knowledge", knowledgeDistillationRouter);
  app.use("/api/knowledge", knowledgeDocumentsRouter);
  app.use("/api/knowledge", knowledgeSearchRouter);
  app.use("/api/remote", remoteRouter);
  app.use("/api/admin/agent-models", agentModelsRouter);
  app.use("/api/admin/recall-settings", recallSettingsRouter);
  app.use("/api/admin/integrations", integrationsRouter);
  app.use("/api/connectors", connectorOauthRouter);
  app.use("/api/connectors", connectorManageRouter);
  app.use("/api/admin/reviews", reviewsRouter);
  app.use("/api/admin/pentests", pentestsRouter);
  app.use("/api/admin/email", adminEmailRouter);
  app.use("/api/admin/orgs", adminOrgsRouter);
  // Hosted webhook ingress — unauthenticated by JWT (verifies the App's HMAC).
  app.use("/api/triggers", triggersRouter);
  app.use("/api/memories", memoriesRouter);
  app.use("/api/scenes", scenesRouter);
  app.use("/api/persona", personaRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api/meetings", meetingsRouter);
  app.use("/api/public/meetings", publicMeetingsRouter);
  app.use("/api/track", trackRouter);
  // ADR-028 Part D — per-user planner sync (migration 051).
  app.use("/api/planner", plannerRouter);
  // ADR-029 Part D — per-user notes sync (migration 052).
  app.use("/api/notes", notesRouter);
  // ADR-029 Q5 — resolution is server-side, because the dashboard has no local
  // store to resolve a reference against.
  app.use("/api/workspace", workspaceRouter);
  app.use("/api/teams", teamsRouter);
  app.use("/api/chat/threads", chatThreadsRouter);
  // Human-facing public share page — the /m/<token> link minted for a public meeting.
  app.use("/m", publicSharePageRouter);
  app.use("/api/vulnerabilities", vulnerabilitiesRouter);
  app.use("/api/vulnerability", vulnerabilitiesRouter);
  app.use("/api/contradictions", contradictionsRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/brain", brainRouter);
  app.use("/api/graph", graphRouter);
  app.use("/api", governanceRouter);
  app.use("/api/evidence", evidenceRouter);
  app.use("/api/fleet", fleetRouter);
  app.use("/api/hooks", hooksRouter);
  app.use("/api/working", workingRouter);
  app.use("/api/skills", skillsRouter);
  } // end serveRest

  // MCP endpoint — handles POST (requests) and GET (SSE stream).
  //
  // The Streamable HTTP MCP SDK strictly requires every POST to send
  // `Accept: application/json, text/event-stream` because the response
  // could be either a plain JSON body or an SSE stream. Naive clients
  // (curl, fetch without explicit headers, older MCP SDK builds, some
  // health-check probes) often send only `application/json` and the
  // SDK rejects them with a `Not Acceptable` 406 — surfacing as a
  // noisy error in the brain logs that operators can't easily map
  // back to the offending client.
  //
  // We promote `Accept: application/json` → `Accept: application/json,
  // text/event-stream` *before* delegating to the SDK so the request
  // proceeds, then log a one-time warning per User-Agent so the
  // operator can find and fix the misbehaving client. This is safe:
  // the SDK only enters SSE mode if the handler explicitly streams,
  // which never happens for the JSON-only request shapes the naive
  // clients send.
  function promoteAcceptHeader(req: Request): void {
    if (req.method !== 'POST') return;
    const decision = decideMcpAcceptPromotion(
      typeof req.headers.accept === 'string' ? req.headers.accept : '',
    );
    if (!decision.promote) return;
    req.headers.accept = decision.value;
    const ua = (req.headers['user-agent'] as string | undefined) ?? '(no user-agent)';
    if (!warnedUserAgents.has(ua)) {
      warnedUserAgents.add(ua);
      console.error(
        `[BrainRouter] MCP client missing 'text/event-stream' in Accept header — promoting transparently. ` +
          `Update the client to send 'Accept: application/json, text/event-stream' on every POST to /mcp. ` +
          `User-Agent: ${ua}`,
      );
    }
  }

  async function handleMcp(req: Request, res: Response) {
    promoteAcceptHeader(req);
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const authHeader = req.headers.authorization;
    const bearerKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!bearerKey) {
      res.status(401).json({ error: 'API key required. Set Authorization: Bearer <your_api_key>' });
      return;
    }
    const user = await memoryEngine.getUserByApiKey(bearerKey);
    if (!user) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }
    if (user.status === "disabled") {
      res.status(403).json({ error: "Account disabled" });
      return;
    }
    const effectiveUserId = user.userId;
    // C1 (ADR-016) — resolve the caller's active org (X-BrainRouter-Org header,
    // else their default org) so the MCP recall path can surface org-shared memory.
    // A repeated header arrives as string[] — coerce safely so `.trim()` can't throw.
    const orgHeader = req.headers['x-brainrouter-org'];
    const requestedOrg = (Array.isArray(orgHeader) ? orgHeader[0] : orgHeader)?.trim() || undefined;
    const orgCtx = await resolveOrgContext(memoryEngine.tenancy, effectiveUserId, requestedOrg).catch(() => null);
    // If the caller EXPLICITLY requested an org it can't access, fail loud instead of
    // silently falling back to no-org (defense-in-depth over the recall layer, which
    // already refuses any client-supplied filters.orgId — org is server-pinned). CWE-284.
    if (requestedOrg && !orgCtx?.orgId) {
      res.status(403).json({ error: 'Not a member of the requested organization.' });
      return;
    }
    const defaultOrgId = orgCtx?.orgId;
    const requestIdentity: McpSessionIdentity = {
      userId: effectiveUserId,
      orgId: defaultOrgId,
      role: orgCtx?.role,
      isAdmin: user.isAdmin,
    };

    if (req.method === 'POST' && !sessionId) {
      // New session — initialise
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { server: mcpServer, transport, identity: requestIdentity });
        },
      });

      const mcpServer = buildMcpServer(registry, {
        defaultUserId: effectiveUserId,
        isAdmin: user.isAdmin,
        defaultOrgId,
        defaultRole: orgCtx?.role,
      });

      transport.onclose = () => {
        const id = [...sessions.entries()].find(([, v]) => v.transport === transport)?.[0];
        if (id) sessions.delete(id);
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Existing session
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(404).json({ error: 'Session not found. Send a POST without mcp-session-id to initialise.' });
      return;
    }
    if (!matchesMcpSessionIdentity(session.identity, requestIdentity)) {
      res.status(403).json({ error: 'MCP session authentication context changed. Reconnect to continue.' });
      return;
    }

    await session.transport.handleRequest(req, res, req.body);
  }

  // DoS backstop on the MCP tool transport (env-tunable; default 600/min — well
  // above a normal agent's tool-call cadence, so it only trips a runaway).
  // Mounted only when this process serves the MCP plane (SERVICE=brain|mcp).
  if (serveMcp) {
    app.use('/mcp', apiRateLimit);
    app.post('/mcp', handleMcp);
    app.get('/mcp', handleMcp);

    // DELETE — client-side session teardown
    app.delete('/mcp', (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId) sessions.delete(sessionId);
      res.status(204).send();
    });
  }

  const dashboardDist = path.resolve(process.cwd(), "..", "dashboard", "dist");
  if (fs.existsSync(dashboardDist)) {
    app.use("/dashboard", express.static(dashboardDist));
    app.get("/dashboard/*", (_req: Request, res: Response) => {
      res.sendFile(path.join(dashboardDist, "index.html"));
    });
  }

  // BRAIN-BODY-LIMIT — map an oversized JSON body to a clean 413 instead of an
  // unhandled PayloadTooLargeError (which surfaced as a raw 500/crash). Registered
  // after the routes so a body-parser parse error from express.json() reaches it.
  app.use(payloadTooLargeHandler(jsonBodyLimit));

  // API-ERRORS: terminal handler — one consistent { error, code } envelope for
  // anything that bubbles past the routes; never leaks a stack/internal message
  // to clients in production. Mounted LAST so specific handlers (413) run first.
  app.use(errorHandler({ production: IS_PRODUCTION }));

  const httpServer = app.listen(PORT, () => {
    console.log(`\n🧠 BrainRouter MCP Server`);
    console.log(`   Transport : HTTP (Streamable)`);
    console.log(`   Endpoint  : http://localhost:${PORT}/mcp`);
    console.log(`   Health    : http://localhost:${PORT}/health`);
    console.log(`   Root      : ${config.localRoot}\n`);
  });

  // Fast, idempotent shutdown on SIGINT *and* SIGTERM (the latter is what
  // `tsx watch` sends on a file change). Without this the open keep-alive
  // connections + background sweeper intervals keep the event loop alive, so
  // `httpServer.close()`'s callback never fires and the dev watcher has to
  // force-kill after 5s. We drop connections immediately and hold a short hard
  // deadline so the process always exits well before any force-kill.
  let shuttingDown = false;
  const shutdownHttp = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const hardExit = setTimeout(() => process.exit(0), 700);
    hardExit.unref();
    // Stop the engine's sweepers/job-runner and close the pg pool so the event
    // loop drains cleanly (best-effort; the hard deadline above still guarantees
    // exit if the pool is slow to close).
    void closeMemoryEngine().catch(() => undefined);
    try { httpServer.closeAllConnections?.(); } catch { /* older Node */ }
    httpServer.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdownHttp);
  process.on('SIGTERM', shutdownHttp);

} else {
  // ── stdio transport (default) ───────────────────────────────────────────────
  
  // Redirect console.log and console.warn to stderr to avoid polluting stdout.
  // In stdio mode, stdout is strictly reserved for the MCP protocol.
  console.log = (...args) => console.error(...args);
  console.warn = (...args) => console.error(...args);

  // Authenticate user via environment variable or CLI flag
  let stdioUserId = "";
  let stdioIsAdmin = false;
  
  const stdioApiKey = (process.env.BRAINROUTER_API_KEY ?? parseFlag('--apiKey'))?.trim();
  if (!stdioApiKey) {
    console.error("[BrainRouter] FATAL: Connection aborted. Authentication is strictly required for all tool operations.");
    console.error("[BrainRouter] To fix this, please configure BRAINROUTER_API_KEY inside your MCP client config environment variables.");
    console.error("[BrainRouter] Example configuration:");
    console.error(JSON.stringify({
      mcpServers: {
        brainrouter: {
          command: "node",
          args: [
            "/absolute/path/to/BrainRouter/brainrouter/dist/index.js",
            "--root",
            "/absolute/path/to/your/workspace"
          ],
          env: {
            BRAINROUTER_API_KEY: "br_YOUR_API_KEY"
          }
        }
      }
    }, null, 2));
    process.exit(1);
  }

  const user = await memoryEngine.getUserByApiKey(stdioApiKey);
  if (!user) {
    console.error("[BrainRouter] FATAL: The provided BRAINROUTER_API_KEY is invalid. Connection aborted.");
    process.exit(1);
  }
  if (user.status === "disabled") {
    console.error("[BrainRouter] FATAL: The provided BRAINROUTER_API_KEY belongs to a disabled account.");
    process.exit(1);
  }
  
  stdioUserId = user.userId;
  stdioIsAdmin = user.isAdmin;
  console.error(`[BrainRouter] Authenticated via BRAINROUTER_API_KEY. Mapping local session to user: ${user.displayName || user.userId}`);

  const server = buildMcpServer(registry, { defaultUserId: stdioUserId, isAdmin: stdioIsAdmin });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('BrainRouter MCP server running on stdio');

  let stdioShuttingDown = false;
  const shutdownStdio = async () => {
    if (stdioShuttingDown) return;
    stdioShuttingDown = true;
    const hardExit = setTimeout(() => process.exit(0), 700);
    hardExit.unref();
    try { await server.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdownStdio);
  process.on('SIGTERM', shutdownStdio);
}

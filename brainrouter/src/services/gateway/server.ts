/**
 * Provider/LLM-Gateway HTTP surface (ADR-010 P7). A tiny Express app other
 * services call to resolve their org's provider config. Service-to-service auth
 * reuses the brain's JWT (same BRAINROUTER_JWT_SECRET), so no new trust root.
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { verifyJwt } from "../../api/auth/crypto.js";
import { isProviderKind } from "../../providers/types.js";
import type { GatewayProviderService } from "./providerPool.js";

export function createGatewayApp(svc: GatewayProviderService, jwtSecret: string) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // Health is unauthenticated (liveness/readiness probes).
  app.get("/health", async (_req: Request, res: Response) => {
    const db = await svc.ping();
    res.json({ status: db ? "ok" : "degraded", service: "provider-gateway", db });
  });

  // Everything else needs a valid JWT (the same one the brain issues).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const h = req.headers.authorization;
    const token = h?.startsWith("Bearer ") ? h.slice(7).trim() : "";
    const payload = token.split(".").length === 3 ? verifyJwt(token, jwtSecret) : null;
    if (!payload) { res.status(401).json({ error: "gateway: a valid JWT is required", code: "unauthorized" }); return; }
    next();
  });

  // POST /v1/resolve { orgId, kind } → the org's DB-resolved provider (DB-first,
  // env fallback). Returns the decrypted key over this INTERNAL authed channel.
  app.post("/v1/resolve", async (req: Request, res: Response) => {
    const orgId = String(req.body?.orgId ?? "").trim();
    const kind = String(req.body?.kind ?? "").trim();
    if (!orgId || !isProviderKind(kind)) {
      res.status(400).json({ error: "orgId and a valid kind (llm|embedding|reranker|judge) are required", code: "invalid_request" });
      return;
    }
    try {
      const provider = await svc.resolve(orgId, kind);
      if (!provider) { res.status(404).json({ error: "no provider configured for that org/kind", code: "not_found" }); return; }
      res.json({ provider });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : "resolve failed", code: "internal_error" });
    }
  });

  return app;
}

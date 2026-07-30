/**
 * Trigger-Ingress microservice HTTP surface (ADR-011). A stateless webhook
 * receiver — the SAME processGithubDelivery core as the in-brain route, over
 * injected deps. No JWT (webhooks carry none); it authenticates by the App HMAC.
 */
import express, { type Request, type Response } from "express";
import { processGithubDelivery, type WebhookDeps } from "../../integrations/githubWebhook.js";

export function createIngressApp(deps: WebhookDeps, opts?: { ping?: () => Promise<boolean> }) {
  const app = express();
  // Capture the raw bytes so the HMAC matches GitHub's exact payload.
  app.use(express.json({
    limit: "5mb",
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => { req.rawBody = buf; },
  }));

  app.get("/health", async (_req: Request, res: Response) => {
    const db = opts?.ping ? await opts.ping() : true;
    res.json({ status: db ? "ok" : "degraded", service: "trigger-ingress", db });
  });

  app.post("/api/triggers/github/events", async (req: Request & { rawBody?: Buffer }, res: Response) => {
    const sig = req.headers["x-hub-signature-256"];
    const out = await processGithubDelivery(deps, {
      body: (req.body ?? {}) as Record<string, unknown>,
      rawBody: req.rawBody ?? Buffer.alloc(0),
      signature: Array.isArray(sig) ? sig[0] : sig,
      event: String(req.headers["x-github-event"] ?? "").trim(),
      delivery: String(req.headers["x-github-delivery"] ?? "").trim(),
    });
    res.status(out.status).json(out.body);
  });

  return app;
}

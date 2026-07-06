/**
 * In-brain GitHub webhook route (ADR-010 P6b). Thin adapter: it feeds the shared
 * {@link processGithubDelivery} core with engine-backed deps. The SAME core runs
 * in the standalone ingress microservice (services/ingress) — one source of truth.
 */
import { Router, type Request, type Response } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { processGithubDelivery, type WebhookDeps } from "../../../integrations/githubWebhook.js";

export const triggersRouter = Router();

const engineDeps: WebhookDeps = {
  findIntegrationByInstallation: (installationId) =>
    memoryEngine.integrations.findIntegrationByInstallation("github_app", installationId),
  enqueue: async (job) => {
    await (memoryEngine.store as { enqueueMemoryJob?: (input: unknown) => Promise<unknown> }).enqueueMemoryJob?.(job);
  },
};

triggersRouter.post("/github/events", async (req: Request & { rawBody?: Buffer }, res: Response) => {
  const sig = req.headers["x-hub-signature-256"];
  const out = await processGithubDelivery(engineDeps, {
    body: (req.body ?? {}) as Record<string, unknown>,
    rawBody: req.rawBody ?? Buffer.alloc(0),
    signature: Array.isArray(sig) ? sig[0] : sig,
    event: String(req.headers["x-github-event"] ?? "").trim(),
    delivery: String(req.headers["x-github-delivery"] ?? "").trim(),
  });
  res.status(out.status).json(out.body);
});

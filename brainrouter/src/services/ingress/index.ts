/**
 * Trigger-Ingress microservice entry (ADR-011). Runs standalone:
 *   node dist/services/ingress/index.js
 * Light: its own pg.Pool + the integration/job queries (NOT the full engine —
 * the brain owns schema; ingress only reads integration_configs + enqueues).
 */
import pg from "pg";
import { makePoolExecutor } from "../gateway/providerPool.js";
import { findIntegrationByInstallation } from "../../memory/store/postgres/queries/integrationConfigQueries.js";
import { enqueueMemoryJob, cancelSupersededReviewJobs } from "../../memory/store/postgres/queries/jobQueries.js";
import { createIngressApp } from "./server.js";
import type { WebhookDeps } from "../../integrations/githubWebhook.js";

function main(): void {
  const url = process.env.BRAINROUTER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) { console.error("[trigger-ingress] BRAINROUTER_DATABASE_URL (or DATABASE_URL) is required"); process.exit(1); }
  if (!process.env.BRAINROUTER_SECRET_KEY?.trim()) {
    console.error("[trigger-ingress] BRAINROUTER_SECRET_KEY is required (to open the App's webhook secret)");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url });
  const exec = makePoolExecutor(pool);

  const deps: WebhookDeps = {
    findIntegrationByInstallation: (installationId) => findIntegrationByInstallation(exec, "github_app", installationId),
    enqueue: async (job) => { await enqueueMemoryJob(exec, job as unknown as Parameters<typeof enqueueMemoryJob>[1]); },
    cancelSupersededReviews: async (input) => { await cancelSupersededReviewJobs(exec, input); },
  };
  const app = createIngressApp(deps, { ping: async () => { try { await pool.query("SELECT 1"); return true; } catch { return false; } } });

  const port = parseInt(process.env.INGRESS_PORT ?? "3749", 10);
  const server = app.listen(port, () => console.error(`[trigger-ingress] listening on :${port}`));
  const shutdown = () => { server.close(); void pool.end(); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();

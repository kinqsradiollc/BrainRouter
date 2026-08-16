/**
 * Provider/LLM-Gateway entry point (ADR-010 P7). Run as its own process:
 *   node dist/services/gateway/index.js
 * Deployed via deploy/stack (the `gateway` service reuses the brain image).
 */
import { GatewayProviderService } from "./providerPool.js";
import { createGatewayServer } from "./server.js";

function main(): void {
  const url = process.env.BRAINROUTER_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("[provider-gateway] BRAINROUTER_DATABASE_URL (or DATABASE_URL) is required");
    process.exit(1);
  }
  const jwtSecret = process.env.BRAINROUTER_JWT_SECRET?.trim();
  if (!jwtSecret) {
    console.error("[provider-gateway] BRAINROUTER_JWT_SECRET is required (shared with the brain)");
    process.exit(1);
  }
  const port = parseInt(process.env.GATEWAY_PORT ?? "3748", 10);
  const svc = new GatewayProviderService(url, jwtSecret);
  const { server, audioStreaming } = createGatewayServer(svc);
  server.listen(port, () => console.error(`[provider-gateway] listening on :${port}`));

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      await audioStreaming.close().catch(() => undefined);
      const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      try { server.closeAllConnections?.(); } catch { /* older Node */ }
      await httpClosed;
      await svc.close().catch(() => undefined);
    })();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();

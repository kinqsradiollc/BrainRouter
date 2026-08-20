/**
 * Provider/LLM-Gateway entry point (ADR-010 P7). Run as its own process:
 *   node dist/services/gateway/index.js
 * Deployed via deploy/stack (the `gateway` service reuses the brain image).
 */
import { GatewayProviderService } from "./providerPool.js";
import { createGatewayServer } from "./server.js";
import { EgressTunnelService } from "./egress/egressTunnelService.js";
import type { GatewayEgressSelection } from "./chatRoutes.js";

/** ADR-043 C6b — the edge-egress tunnel is OFF unless GATEWAY_EGRESS_ENABLED is set. */
function egressConfigFromEnv() {
  const enabled = /^(1|true)$/i.test(process.env.GATEWAY_EGRESS_ENABLED ?? "");
  return {
    enabled,
    host: process.env.GATEWAY_EGRESS_HOST,
    controlPort: parseInt(process.env.GATEWAY_EGRESS_CONTROL_PORT ?? "3749", 10),
    relayPort: parseInt(process.env.GATEWAY_EGRESS_RELAY_PORT ?? "3750", 10),
    relayPublicUrl: process.env.GATEWAY_EGRESS_RELAY_URL,
  };
}

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

  // ADR-043 C6b — the tunnel service + per-request selection. When disabled the
  // service stays dark AND `egress` is left undefined, so the data plane never
  // even evaluates the tunnel path (direct server egress exactly as before).
  const egressConfig = egressConfigFromEnv();
  const egressService = new EgressTunnelService({
    config: egressConfig,
    store: { getDeviceSessionByTokenHash: (o, u, h) => svc.getDeviceSessionByTokenHash(o, u, h) },
    ping: () => svc.ping(),
  });
  // Short-TTL caches so a burst of eligible requests does not re-read the same
  // rows every time (the values change rarely). Both fail open — a throwing read
  // is caught upstream and the request takes direct server egress.
  const optInCache = new Map<string, { value: boolean; expires: number }>();
  const killCache = { killed: false, expires: 0 };
  const OPT_IN_TTL_MS = 30_000;
  const egressSelection: GatewayEgressSelection | undefined = egressConfig.enabled
    ? {
        transportForAccount: (orgId, userId, keyId) => egressService.transportForAccount(orgId, userId, keyId),
        orgOptIn: async (orgId) => {
          const now = Date.now();
          // ADR-043 C7 (D2) — the global kill-switch force-disables the tunnel for
          // EVERY org without a restart (an ops lever above per-org consent).
          if (killCache.expires <= now) {
            const kill = await svc.getOrgSetting<{ killed?: boolean }>(`egress:clientTunnelKill`);
            killCache.killed = kill?.killed === true;
            killCache.expires = now + OPT_IN_TTL_MS;
          }
          if (killCache.killed) return false;
          const cached = optInCache.get(orgId);
          if (cached && cached.expires > now) return cached.value;
          const setting = await svc.getOrgSetting<{ enabled?: boolean }>(`egress:clientTunnelOptIn:${orgId}`);
          const value = setting?.enabled === true;
          optInCache.set(orgId, { value, expires: now + OPT_IN_TTL_MS });
          return value;
        },
        onFallback: (reason) => console.error(`[provider-gateway] egress tunnel fell back to direct: ${reason.message}`),
      }
    : undefined;

  const { server, audioStreaming } = createGatewayServer(svc, { egress: egressSelection });
  server.listen(port, () => console.error(`[provider-gateway] listening on :${port}`));
  // Fire-and-forget, but NEVER let a bind failure become an unhandled rejection
  // that kills the already-listening gateway — on failure the tunnel stays dark.
  void egressService
    .start()
    .then(() => {
      if (egressConfig.enabled) {
        console.error(
          `[provider-gateway] egress tunnel up (control :${egressService.boundControlPort}, relay :${egressService.boundRelayPort})`,
        );
      }
    })
    .catch((err: unknown) => {
      console.error(
        `[provider-gateway] egress tunnel failed to start; staying dark: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      await egressService.stop().catch(() => undefined);
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

// ADR-041 A41-12 — the generic service loader: `node dist/services/loader.js <profile-id>`.
//
// One entrypoint boots any registered service from its profile. The container image
// (deploy/stack) runs `node dist/services/loader.js provider-gateway` instead of a
// bespoke per-service entry module — the service PROFILE is the authoritative boot
// source: its id selects the entrypoint (serviceEntrypoints.ts), its defaultPort is
// the listen port (overridable by GATEWAY_PORT). Unknown ids and unregistered
// entrypoints are fail-loud boot errors, never a silently-dark container.

import { pathToFileURL } from "node:url";
import { resolveServiceProfile } from "@kinqs/brainrouter-core/runtime";
import { SERVICE_ENTRYPOINTS, type ServiceEntrypoint, type ServiceHandle } from "./serviceEntrypoints.js";

/**
 * Resolve `id` to its profile + entrypoint and boot it, or throw a fail-loud
 * error. `entrypoints` is injectable so a test can boot a spy instead of the real
 * service; production passes the default registry.
 */
export function bootService(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  entrypoints: Record<string, ServiceEntrypoint> = SERVICE_ENTRYPOINTS,
): ServiceHandle {
  const profile = resolveServiceProfile(id);
  if (!profile) {
    throw new Error(`Unknown service profile "${id}". Run a registered service id.`);
  }
  const entrypoint = entrypoints[id];
  if (!entrypoint) {
    throw new Error(`Service "${id}" has a profile but no registered entrypoint.`);
  }
  const envPort = env.GATEWAY_PORT ? parseInt(env.GATEWAY_PORT, 10) : undefined;
  const port = Number.isInteger(envPort) && envPort! > 0 ? envPort! : profile.defaultPort;
  return entrypoint(port);
}

function main(): void {
  const id = process.argv[2];
  if (!id) {
    console.error("[service-loader] usage: node dist/services/loader.js <profile-id>");
    process.exit(1);
  }
  let handle: ServiceHandle;
  try {
    handle = bootService(id);
  } catch (error) {
    console.error(`[service-loader] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const onSignal = () => { void handle.stop(); };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
}

// Run only when executed directly (the container entry); importing bootService for
// a test or another caller must not boot a service or exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

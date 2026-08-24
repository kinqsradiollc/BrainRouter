// ADR-041 A41-12 — the service-entrypoint registry.
//
// A service profile (packages/core, SERVICE_PROFILES) describes a runnable service
// declaratively — its id, transport, default port, remote-bindability. This maps a
// profile id to the code that actually BOOTS it, so the generic loader
// (`node dist/services/loader.js <profile-id>`, loader.ts) can start any registered
// service from its profile alone: the profile is now the authoritative boot source
// (id → entrypoint, defaultPort → listen port), and the container image carries no
// bespoke per-service entrypoint logic beyond the loader + a profile name.

import type { ServiceProfileId } from "@kinqs/brainrouter-core/runtime";
import { startProviderGateway } from "./gateway/index.js";

/** A running service's stop handle. `stop()` is idempotent and awaits full teardown. */
export interface ServiceHandle {
  stop(): Promise<void>;
}

/** Boots a service on `port` and returns its stop handle. */
export type ServiceEntrypoint = (port: number) => ServiceHandle;

/** The boot function for each service profile. Keyed by the profile id. */
export const SERVICE_ENTRYPOINTS: Record<ServiceProfileId, ServiceEntrypoint> = {
  "provider-gateway": (port) => startProviderGateway(port),
};

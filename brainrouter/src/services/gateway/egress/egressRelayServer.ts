import { RemoteRelayServer } from "../../remoteRelay/server.js";
import { EgressRelayControlPlane } from "./egressRelayControlPlane.js";
import type { EgressTicketRegistry } from "./egressTicket.js";

/** ADR-043 — the egress relay binds a path distinct from device pairing. */
export const EGRESS_RELAY_PATH = "/egress-relay";

/**
 * ADR-043 S3b (C2) — stand up a {@link RemoteRelayServer} that splices EGRESS
 * legs. It reuses the pairing relay's payload-blind splice verbatim (128 KiB
 * frame ceiling, 200 fps + 4 MiB backpressure, opcode-preserving forward, the
 * `RELAY_CLOSE` codes); only the control plane and the WS path differ. The relay
 * still never sees the dial target or the credential — it splices ciphertext
 * between the gateway (`origin:`) seat and the user's client seat.
 *
 * Single-node constraint: {@link EgressTicketRegistry} is in-process, so the node
 * that mints the ticket pair (the gateway opener, C3/C4) and the node running
 * this relay must be the same instance for the default deployment. Promoting the
 * registry to a shared store is the documented multi-instance follow-up.
 */
export function createEgressRelayServer(options: {
  registry: EgressTicketRegistry;
  ping: () => Promise<boolean>;
  now?: () => number;
}): RemoteRelayServer {
  return new RemoteRelayServer({
    controlPlane: new EgressRelayControlPlane(options.registry, { now: options.now }),
    ping: options.ping,
    path: EGRESS_RELAY_PATH,
    now: options.now,
  });
}

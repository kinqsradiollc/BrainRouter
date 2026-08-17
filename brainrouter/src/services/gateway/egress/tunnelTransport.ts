import type { Duplex } from 'node:stream';
import type { ValidatedUpstreamTarget } from '@kinqs/brainrouter-core/provider';

/**
 * ADR-043 S3 — the concrete `host:port` the gateway needs reached THROUGH the
 * user's edge device. It is derived from an already-policy-validated upstream
 * target (`validateUpstreamTarget` runs in `fetchUpstreamWithPolicy` before any
 * dialer is invoked), so the allowlist / SSRF checks have already passed by the
 * time a tunnel is opened.
 */
export interface EgressDialTarget {
  readonly host: string;
  readonly port: number;
}

/**
 * ADR-043 S3 (D1/D6) — an opaque byte tunnel to a provider endpoint, opened
 * through the requesting user's own device over the remote-relay substrate.
 *
 * The gateway writes TLS records into this duplex and reads ciphertext back; the
 * relaying device only ever sees ciphertext it cannot decrypt, because the
 * credential lives inside a TLS session the SERVER terminates (ADR-043 D1). This
 * interface is the seam the tunnel {@link EgressTunnelTransport} plugs the relay
 * into: S3b implements it over the relay's ticketed splice (its own channel type,
 * consumer id, and allowlist per §8.3); tests provide an in-memory duplex.
 */
export interface EgressTunnelTransport {
  /**
   * Open a raw byte tunnel to `target.host:target.port` via the user's edge.
   * Rejects when no edge channel is available — the dialer then fails the connect
   * and the caller's fallback ladder drops to server egress (ADR-043 D4).
   */
  open(target: EgressDialTarget, options?: { readonly signal?: AbortSignal }): Promise<Duplex>;
}

/** Resolve the concrete `host:port` from a validated target (default ports by scheme). */
export function dialTargetFromValidated(target: ValidatedUpstreamTarget): EgressDialTarget {
  const { url } = target;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { host: url.hostname, port };
}

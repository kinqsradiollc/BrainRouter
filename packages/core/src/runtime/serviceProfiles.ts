// ADR-041 A41-12 — service profiles + typed remote binding. A service profile
// describes a RUNNABLE service (a long-lived process/endpoint the runtime composes)
// declaratively: what it exposes, and — critically for ADR-043 — whether its seam
// is remote-bindable. The provider gateway is the first subsystem re-expressed this
// way (per ADR-043, it is the natural first). The "boot error for the rest"
// requirement is `assertRemoteBindable`: requesting a remote binding for a service
// whose seam is NOT remote-capable is a boot-time failure, not a silent no-op.
//
// This is the profile + remote-binding foundation; reducing a service's Docker
// image to "loader + profile" and regenerating dev-compose from profile sets build
// on it.

export type ServiceTransport = 'http';

export interface ServiceProfile {
  /** Stable id a loader / compose file references, e.g. `provider-gateway`. */
  id: string;
  description: string;
  /** How the service is reached. */
  transport: ServiceTransport;
  /** The port the service listens on by default. */
  defaultPort: number;
  /**
   * ADR-043 — whether this service's seam may be bound to a remote target (the
   * edge egress tunnel). A service that terminates provider TLS server-side is
   * remote-capable; one that must stay in-process is not. `assertRemoteBindable`
   * turns a wrong request into a boot error.
   */
  remoteCapable: boolean;
}

export const SERVICE_PROFILES = {
  'provider-gateway': {
    id: 'provider-gateway',
    description: 'OpenAI-compatible provider gateway — a thin proxy that terminates provider TLS server-side.',
    transport: 'http',
    defaultPort: 3748,
    // ADR-043 — the gateway is the seam the edge egress tunnel binds; provider TLS
    // + credentials stay on the server, so remote binding is safe here.
    remoteCapable: true,
  },
} satisfies Record<string, ServiceProfile>;

export type ServiceProfileId = keyof typeof SERVICE_PROFILES;

/** The profile for a service id, or undefined if unknown. */
export function resolveServiceProfile(id: string): ServiceProfile | undefined {
  return (SERVICE_PROFILES as Record<string, ServiceProfile>)[id];
}

/** Every registered service id, in insertion order. */
export function serviceProfileIds(): string[] {
  return Object.keys(SERVICE_PROFILES);
}

/** Raised at boot when a remote binding is requested for a non-remote-capable service. */
export class RemoteBindingUnsupportedError extends Error {
  constructor(public readonly serviceId: string) {
    super(
      `Service "${serviceId}" is not remote-bindable — its seam must run in-process. ` +
        `Remove the remote binding for this service or choose a remote-capable one.`,
    );
    this.name = 'RemoteBindingUnsupportedError';
  }
}

/**
 * ADR-041 A41-12 / ADR-043 — the typed remote binding gate. Call at boot before
 * wiring a remote target to a service's seam: it returns the profile when the
 * service is remote-capable, and THROWS (fail-closed boot error) otherwise, so a
 * misconfiguration can never silently downgrade to an in-process seam pretending
 * to be remote.
 */
export function assertRemoteBindable(id: string): ServiceProfile {
  const profile = resolveServiceProfile(id);
  if (!profile) throw new RemoteBindingUnsupportedError(id);
  if (!profile.remoteCapable) throw new RemoteBindingUnsupportedError(id);
  return profile;
}

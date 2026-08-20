// ADR-041 A41-11 — host profiles. The runtime is composed differently by each of
// the four hosts: the CLI is an interactive agent (tools + slash commands), the
// desktop is the CLI plus UI panels, the server exposes the MCP tool surface + the
// HTTP API, and the provider gateway is a thin OpenAI-compatible proxy (providers
// only, no agent tools). A profile names, per host, WHICH composition surfaces it
// activates — a declarative description that `dump-composition --profile <host>`
// renders against the live registries (compositionSnapshot). Layered overlays that
// target individual rows by id build on this; this is the baseline set.
export type HostId = 'cli' | 'desktop' | 'server' | 'gateway';

/** The composition surfaces a host may activate — the registries A41-7 landed. */
export interface HostProfileSurfaces {
  /** Builtin agent tools (planner, fs, exec, …) — the interactive agent loop. */
  agentTools: boolean;
  /** CLI slash commands (/help, /plan, …). */
  slashCommands: boolean;
  /** The MCP tool surface (server transports). */
  mcpTools: boolean;
  /** The HTTP `/api/*` route surface. */
  apiRoutes: boolean;
  /** Desktop UI panels. */
  panels: boolean;
  /** The model provider catalog. */
  providers: boolean;
}

export interface HostProfile {
  host: HostId;
  description: string;
  surfaces: HostProfileSurfaces;
}

const none: HostProfileSurfaces = {
  agentTools: false, slashCommands: false, mcpTools: false, apiRoutes: false, panels: false, providers: false,
};

export const HOST_PROFILES: Readonly<Record<HostId, HostProfile>> = {
  cli: {
    host: 'cli',
    description: 'Interactive terminal agent — builtin tools + slash commands over the provider catalog.',
    surfaces: { ...none, agentTools: true, slashCommands: true, providers: true },
  },
  desktop: {
    host: 'desktop',
    description: 'The CLI agent plus the desktop UI panels.',
    surfaces: { ...none, agentTools: true, slashCommands: true, providers: true, panels: true },
  },
  server: {
    host: 'server',
    description: 'Headless server — the MCP tool surface and the HTTP /api routes over the provider catalog.',
    surfaces: { ...none, mcpTools: true, apiRoutes: true, providers: true },
  },
  gateway: {
    host: 'gateway',
    description: 'OpenAI-compatible provider gateway — a thin proxy over the provider catalog; no agent tools.',
    surfaces: { ...none, providers: true },
  },
};

/** The profile for a host id, or undefined if unknown. */
export function resolveHostProfile(host: string): HostProfile | undefined {
  return (HOST_PROFILES as Record<string, HostProfile>)[host];
}

/** The host ids that have a profile, in a stable order. */
export function hostProfileIds(): HostId[] {
  return ['cli', 'desktop', 'server', 'gateway'];
}

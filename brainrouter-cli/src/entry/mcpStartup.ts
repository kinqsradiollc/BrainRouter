/**
 * One launch-policy resolver is shared by initial CLI boot and live
 * `/init config` reconciliation. Profile scoping, safe mode, remote-brain
 * fallback, workspace-root injection, and active LLM overlays must not drift
 * merely because the same config was applied after the REPL already started.
 */
import {
  applyBrainUrlOverride,
  embeddedBrainId,
  probeBrainHealth,
  resolvePreferredBrainrouterServerId,
  resolveIdentityFromConfig,
  selectMcpServerIds,
  type BrainHealth,
  type McpServerStatus,
} from '@kinqs/brainrouter-core/mcp';
import {
  resolveCliKnobs,
  saveConfigOrThrow,
  type Config,
  type LLMConfig,
  type ServerConfig,
} from '@kinqs/brainrouter-core/config';
import { applyActiveLlmProfile } from '@kinqs/brainrouter-core/provider';
import { DEFAULT_LLM } from './shared.js';

/** Launch-only choices that must survive an in-session config rewrite. */
export interface RuntimeLaunchPolicy {
  requestedProfile?: string;
  modelOverride?: string;
  strictMcp?: boolean;
  skipMcpForLaunch?: boolean;
  safeMode?: boolean;
}

export interface McpStartupSelectionOptions {
  servers: Record<string, ServerConfig>;
  activeServer?: string;
  activeBrainrouterServer?: string;
  requestedProfile?: string;
  strictMcp?: boolean;
  skipMcpForLaunch?: boolean;
  safeMode?: boolean;
}

export type McpStartupSelection =
  | {
      status: 'ready';
      targetIds: string[];
      intentionallySkipped: boolean;
      ignoredRequestedProfile?: string;
      safeModeSkippedIds?: string[];
    }
  | { status: 'missing-profile'; requestedProfile: string; availableIds: string[] }
  | { status: 'strict-no-profiles' };

/**
 * Resolve startup MCP selection without doing I/O. A wizard Skip is the latest
 * explicit choice and therefore wins for this launch over --profile and
 * --strict-mcp, but it never mutates the durable profile catalog.
 */
export function resolveMcpStartupSelection(
  options: McpStartupSelectionOptions,
): McpStartupSelection {
  if (options.skipMcpForLaunch) {
    return {
      status: 'ready',
      targetIds: [],
      intentionallySkipped: true,
      ...(options.requestedProfile ? { ignoredRequestedProfile: options.requestedProfile } : {}),
    };
  }

  const availableIds = Object.keys(options.servers);
  if (
    options.requestedProfile
    && !Object.prototype.hasOwnProperty.call(options.servers, options.requestedProfile)
  ) {
    return {
      status: 'missing-profile',
      requestedProfile: options.requestedProfile,
      availableIds,
    };
  }
  if (availableIds.length === 0 && options.strictMcp) {
    return { status: 'strict-no-profiles' };
  }

  const preferredBrainrouterServer = resolvePreferredBrainrouterServerId(
    options.servers,
    options.activeBrainrouterServer,
    options.activeServer,
  );
  let targetIds = selectMcpServerIds(
    options.servers,
    preferredBrainrouterServer,
    options.requestedProfile,
  );
  const safeModeSkippedIds: string[] = [];
  if (options.safeMode) {
    targetIds = targetIds.filter((serverId) => {
      const keep = serverId === preferredBrainrouterServer
        || resolveIdentityFromConfig(options.servers[serverId], serverId) === 'brainrouter';
      if (!keep) safeModeSkippedIds.push(serverId);
      return keep;
    });
  }

  return {
    status: 'ready',
    targetIds,
    intentionallySkipped: false,
    ...(safeModeSkippedIds.length > 0 ? { safeModeSkippedIds } : {}),
  };
}

export interface RemoteBrainDecision {
  url: string;
  outcome: 'remote' | 'remote-unreachable' | 'embedded-fallback';
  serverId?: string;
  embeddedServerId?: string;
  health: BrainHealth;
}

export type EffectiveMcpLaunch =
  | ({
      status: 'ready';
      targetIds: string[];
      targetServers: Record<string, ServerConfig>;
      intentionallySkipped: boolean;
      ignoredRequestedProfile?: string;
      safeModeSkippedIds?: string[];
      runtimeServers: Record<string, ServerConfig>;
      runtimeActiveServer?: string;
      runtimeActiveBrainrouterServer?: string;
      remoteBrain?: RemoteBrainDecision;
    })
  | ({
      status: 'missing-profile';
      requestedProfile: string;
      availableIds: string[];
      runtimeServers: Record<string, ServerConfig>;
      runtimeActiveServer?: string;
      runtimeActiveBrainrouterServer?: string;
      remoteBrain?: RemoteBrainDecision;
    })
  | ({
      status: 'strict-no-profiles';
      runtimeServers: Record<string, ServerConfig>;
      runtimeActiveServer?: string;
      runtimeActiveBrainrouterServer?: string;
      remoteBrain?: RemoteBrainDecision;
    });

export interface EffectiveMcpLaunchOptions {
  config: Config;
  workspaceRoot: string;
  policy?: RuntimeLaunchPolicy;
  probeRemoteBrain?: (
    mcpUrl: string,
    options: { timeoutMs: number },
  ) => Promise<BrainHealth>;
}

function cloneServerConfig(server: ServerConfig): ServerConfig {
  return {
    ...server,
    ...(server.args ? { args: [...server.args] } : {}),
    ...(server.env ? { env: { ...server.env } } : {}),
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  };
}

/** Persist a login profile and both independent selectors as one strict edit. */
export function persistSelectedBrainrouterProfile(
  config: Config,
  profileName: string,
  server: ServerConfig,
  persist: (next: Config) => void = saveConfigOrThrow,
): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(profileName)) {
    throw new Error('Invalid BrainRouter profile name.');
  }
  const hadProfile = Object.prototype.hasOwnProperty.call(config.servers, profileName);
  const previousProfile = config.servers[profileName];
  const previousActiveServer = config.activeServer;
  const previousActiveBrainrouterServer = config.activeBrainrouterServer;
  config.servers[profileName] = { ...cloneServerConfig(server), identity: 'brainrouter' };
  config.activeServer = profileName;
  config.activeBrainrouterServer = profileName;
  try {
    persist(config);
  } catch (error) {
    if (hadProfile && previousProfile) config.servers[profileName] = previousProfile;
    else delete config.servers[profileName];
    config.activeServer = previousActiveServer;
    config.activeBrainrouterServer = previousActiveBrainrouterServer;
    throw error;
  }
}

function serverConfigForWorkspace(server: ServerConfig, workspaceRoot: string): ServerConfig {
  const cloned = cloneServerConfig(server);
  if (cloned.type !== 'stdio') return cloned;

  const args = cloned.args ?? [];
  const rootIndex = args.indexOf('--root');
  cloned.args = rootIndex >= 0
    ? [...args.slice(0, rootIndex + 1), workspaceRoot, ...args.slice(rootIndex + 2)]
    : [...args, '--root', workspaceRoot];
  return cloned;
}

/** Resolve the exact provider snapshot used by both boot and live refresh. */
export function resolveEffectiveLlmConfig(
  config: Config,
  policy: RuntimeLaunchPolicy = {},
): LLMConfig {
  const llm = applyActiveLlmProfile(
    resolveCliKnobs(config),
    { ...(config.llm ?? DEFAULT_LLM) },
  );
  const modelOverride = policy.modelOverride?.trim();
  return modelOverride ? { ...llm, model: modelOverride } : llm;
}

/**
 * Resolve the complete MCP launch without mutating the persisted/shared config.
 * The health probe is injectable so fallback policy has deterministic tests.
 */
export async function resolveEffectiveMcpLaunch(
  options: EffectiveMcpLaunchOptions,
): Promise<EffectiveMcpLaunch> {
  const policy = options.policy ?? {};
  let runtimeServers = Object.fromEntries(
    Object.entries(options.config.servers).map(([serverId, server]) => [serverId, cloneServerConfig(server)]),
  );
  let runtimeActiveServer = options.config.activeServer || undefined;
  let runtimeActiveBrainrouterServer = resolvePreferredBrainrouterServerId(
    runtimeServers,
    options.config.activeBrainrouterServer,
    runtimeActiveServer,
  );
  let remoteBrain: RemoteBrainDecision | undefined;

  // Skip is the latest explicit choice for this launch and avoids even a
  // remote health probe. Saved profiles remain untouched for the next launch.
  if (!policy.skipMcpForLaunch) {
    const brainUrl = resolveCliKnobs(options.config).brainUrl;
    if (brainUrl) {
      const health = await (options.probeRemoteBrain ?? probeBrainHealth)(brainUrl, { timeoutMs: 3_000 });
      const embeddedServerId = embeddedBrainId(runtimeServers, runtimeActiveBrainrouterServer);
      if (health.ok || !embeddedServerId) {
        const overridden = applyBrainUrlOverride(runtimeServers, runtimeActiveBrainrouterServer, brainUrl);
        runtimeServers = overridden.servers;
        runtimeActiveBrainrouterServer = overridden.activeServer;
        remoteBrain = {
          url: brainUrl,
          outcome: health.ok ? 'remote' : 'remote-unreachable',
          serverId: overridden.activeServer,
          health,
        };
      } else {
        runtimeActiveBrainrouterServer = embeddedServerId;
        remoteBrain = {
          url: brainUrl,
          outcome: 'embedded-fallback',
          embeddedServerId,
          health,
        };
      }
    }
  }

  const selection = resolveMcpStartupSelection({
    servers: runtimeServers,
    activeServer: runtimeActiveServer,
    activeBrainrouterServer: runtimeActiveBrainrouterServer,
    requestedProfile: policy.requestedProfile,
    strictMcp: policy.strictMcp,
    skipMcpForLaunch: policy.skipMcpForLaunch,
    safeMode: policy.safeMode,
  });
  if (selection.status !== 'ready') {
    return {
      ...selection,
      runtimeServers,
      runtimeActiveServer,
      runtimeActiveBrainrouterServer,
      ...(remoteBrain ? { remoteBrain } : {}),
    };
  }

  const targetServers: Record<string, ServerConfig> = {};
  for (const serverId of selection.targetIds) {
    targetServers[serverId] = serverConfigForWorkspace(runtimeServers[serverId], options.workspaceRoot);
  }
  return {
    ...selection,
    targetServers,
    runtimeServers,
    runtimeActiveServer,
    runtimeActiveBrainrouterServer,
    ...(remoteBrain ? { remoteBrain } : {}),
  };
}

export interface RuntimeMcpState {
  servers: Record<string, ServerConfig>;
  activeServer?: string;
  activeBrainrouterServer?: string;
}

/** Build an isolated launch-only view; this object must never be persisted. */
export function createRuntimeMcpState(
  launch: Extract<EffectiveMcpLaunch, { status: 'ready' }>,
): RuntimeMcpState {
  const servers = { ...launch.runtimeServers };
  for (const [serverId, server] of Object.entries(launch.targetServers)) {
    servers[serverId] = server;
  }
  return {
    servers,
    activeServer: launch.runtimeActiveServer,
    activeBrainrouterServer: launch.runtimeActiveBrainrouterServer,
  };
}

/**
 * Mirror a successfully persisted login selection into the current session.
 * The durable profile remains canonical on the next launch; this overlay only
 * prevents reconnect/logout in the existing process from following an older
 * transient selector.
 */
export function runtimeMcpStateWithSelectedBrainrouter(
  runtime: RuntimeMcpState | undefined,
  profileName: string,
  profile: ServerConfig,
  activeServer?: string,
): RuntimeMcpState {
  return {
    servers: {
      ...(runtime?.servers ?? {}),
      [profileName]: cloneServerConfig(profile),
    },
    activeServer,
    activeBrainrouterServer: profileName,
  };
}

/** Overlay transient MCP state for display/redaction without mutating config. */
export function configWithRuntimeMcpState(config: Config, runtime?: RuntimeMcpState): Config {
  if (!runtime) return config;
  return {
    ...config,
    servers: { ...config.servers, ...runtime.servers },
    activeServer: config.activeServer,
    activeBrainrouterServer: runtime.activeBrainrouterServer,
  };
}

/**
 * Build a fresh-launch input without feeding projected durable transports back
 * into the resolver. Runtime-only profiles and the live brain selector remain
 * available, while current durable edits and embedded fallback stay canonical.
 */
export function configForRuntimeMcpResolution(config: Config, runtime?: RuntimeMcpState): Config {
  if (!runtime) return config;
  const runtimeOnlyServers = Object.fromEntries(
    Object.entries(runtime.servers).filter(([serverId]) =>
      !Object.prototype.hasOwnProperty.call(config.servers, serverId),
    ),
  );
  return {
    ...config,
    servers: { ...config.servers, ...runtimeOnlyServers },
    activeServer: config.activeServer,
    activeBrainrouterServer: runtime.activeBrainrouterServer ?? config.activeBrainrouterServer,
  };
}

/** Empty status is intentional local-only mode, not a failed connection set. */
export function allMcpConnectionsFailed(statuses: readonly McpServerStatus[]): boolean {
  return statuses.length > 0 && statuses.every((status) => status.status === 'failed');
}

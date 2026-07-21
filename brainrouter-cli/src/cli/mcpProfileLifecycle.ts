/**
 * Session MCP lifecycle for 0.4.17. Launch-time transport projections stay in
 * a transient overlay, while selectors persist only for durable profiles.
 */
import { saveConfigOrThrow } from '@kinqs/brainrouter-core/config';
import {
  resolveIdentityFromConfig,
  type McpServerStatus,
} from '@kinqs/brainrouter-core/mcp';
import type { CommandContext } from './commands/_context.js';
import {
  configForRuntimeMcpResolution,
  configWithRuntimeMcpState,
  createRuntimeMcpState,
  resolveEffectiveLlmConfig,
  resolveEffectiveMcpLaunch,
} from '../entry/mcpStartup.js';

export function isBrainrouterProfile(ctx: CommandContext, serverId: string): boolean {
  const liveIdentity = ctx.mcpClient.getStatus(serverId)?.identity;
  const profile = configWithRuntimeMcpState(ctx.config, ctx.repl.runtimeMcp).servers[serverId];
  return liveIdentity === 'brainrouter'
    || (profile != null && resolveIdentityFromConfig(profile, serverId) === 'brainrouter');
}

/**
 * Remove every non-target BrainRouter profile from live and reconnect state.
 * Pool-only profiles and configured profiles without a live status are both
 * included; `removeOne` is deliberately idempotent.
 */
export async function retireOtherBrainrouterProfiles(
  ctx: CommandContext,
  targetId: string,
): Promise<string[]> {
  if (!isBrainrouterProfile(ctx, targetId)) return [];

  const retired = new Set(otherBrainrouterProfileIds(ctx, targetId));
  for (const serverId of retired) {
    await ctx.mcpClient.removeOne(serverId);
  }
  return [...retired];
}

export function otherBrainrouterProfileIds(ctx: CommandContext, targetId: string): string[] {
  const retired = new Set<string>();
  const effectiveConfig = configWithRuntimeMcpState(ctx.config, ctx.repl.runtimeMcp);
  for (const [serverId, profile] of Object.entries(effectiveConfig.servers)) {
    if (serverId !== targetId && resolveIdentityFromConfig(profile, serverId) === 'brainrouter') {
      retired.add(serverId);
    }
  }
  for (const status of ctx.mcpClient.getStatuses()) {
    if (status.serverId !== targetId && status.identity === 'brainrouter') {
      retired.add(status.serverId);
    }
  }

  return [...retired];
}

export interface ReconcileLiveMcpProfileOptions {
  forceReconnect?: boolean;
  timeoutMs?: number;
  persistActiveBrainrouter?: boolean;
  persistHighlightedProfile?: boolean;
  persistConfig?: typeof saveConfigOrThrow;
}

export class McpProfilePersistenceError extends Error {
  constructor(
    public readonly liveStatus: McpServerStatus,
    cause: unknown,
  ) {
    super(`Live BrainRouter profile switched, but the selection could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'McpProfilePersistenceError';
    this.cause = cause;
  }
}

interface EffectiveMcpProfileResolution {
  profile: ReturnType<typeof createRuntimeMcpState>['servers'][string];
  runtimeMcp: ReturnType<typeof createRuntimeMcpState>;
}

async function resolveEffectiveMcpProfileState(
  ctx: CommandContext,
  serverId: string,
): Promise<EffectiveMcpProfileResolution> {
  const effectiveConfig = configForRuntimeMcpResolution(ctx.config, ctx.repl.runtimeMcp);
  const configuredProfile = effectiveConfig.servers[serverId];
  const resolverConfig = configuredProfile
    && (
      effectiveConfig.activeBrainrouterServer === serverId
      || resolveIdentityFromConfig(configuredProfile, serverId) === 'brainrouter'
    )
    ? { ...effectiveConfig, activeBrainrouterServer: serverId }
    : effectiveConfig;
  const launch = await resolveEffectiveMcpLaunch({
    config: resolverConfig,
    workspaceRoot: ctx.agent.workspaceRoot,
    policy: {
      ...ctx.repl.launchPolicy,
      requestedProfile: serverId,
      skipMcpForLaunch: false,
    },
  });
  if (launch.status !== 'ready') {
    throw new Error(`MCP profile "${serverId}" is not available under the current launch policy.`);
  }
  const profile = launch.targetServers[serverId];
  if (!profile) {
    throw new Error(`MCP profile "${serverId}" is blocked by the current launch policy.`);
  }
  return { profile, runtimeMcp: createRuntimeMcpState(launch) };
}

export async function resolveEffectiveMcpProfile(
  ctx: CommandContext,
  serverId: string,
) {
  return (await resolveEffectiveMcpProfileState(ctx, serverId)).profile;
}

/** Bring one configured profile online while preserving the one-brain invariant. */
export async function reconcileLiveMcpProfile(
  ctx: CommandContext,
  serverId: string,
  options: ReconcileLiveMcpProfileOptions = {},
): Promise<McpServerStatus | undefined> {
  const { profile, runtimeMcp } = await resolveEffectiveMcpProfileState(ctx, serverId);
  const pool = ctx.mcpClient;
  const previousActiveBrainrouterServer = pool.getActiveBrainrouterServerId?.()
    ?? ctx.repl.runtimeMcp?.activeBrainrouterServer
    ?? ctx.config.activeBrainrouterServer;
  // Publish the resolved transport projection immediately, but do not publish
  // its BrainRouter selector until the pool confirms that profile is live. A
  // failed explicit switch must leave reconnect/logout pointed at the brain
  // that is still authenticated in the pool.
  ctx.repl.runtimeMcp = {
    ...runtimeMcp,
    activeBrainrouterServer: previousActiveBrainrouterServer,
  };

  const llmConfig = resolveEffectiveLlmConfig(ctx.config, ctx.repl.launchPolicy);
  pool.stopReconnectSupervisor();
  try {
    pool.setReconnectLlmConfig(llmConfig);
    let brainrouter = isBrainrouterProfile(ctx, serverId);
    const retireBrainrouterServerIds = otherBrainrouterProfileIds(ctx, serverId);

    const current = pool.getStatus(serverId);
    if (!current || options.forceReconnect || current.status !== 'connected') {
      await pool.connectOne(
        serverId,
        profile,
        llmConfig,
        options.timeoutMs ?? 5_000,
        {
          retireBrainrouterServerIds,
          brainrouterPriority: Number.MAX_SAFE_INTEGER,
        },
      );
    } else if (brainrouter) {
      await retireOtherBrainrouterProfiles(ctx, serverId);
    }

    let status = pool.getStatus(serverId);
    if (!brainrouter && status?.identity === 'brainrouter') {
      brainrouter = true;
      await retireOtherBrainrouterProfiles(ctx, serverId);
      status = pool.getStatus(serverId);
    }
    if (brainrouter && status?.status === 'connected' && ctx.repl.runtimeMcp) {
      ctx.repl.runtimeMcp = {
        ...ctx.repl.runtimeMcp,
        activeBrainrouterServer: serverId,
      };
    }
    if (
      brainrouter
      && Object.prototype.hasOwnProperty.call(ctx.config.servers, serverId)
      && options.persistActiveBrainrouter !== false
      && status?.status === 'connected'
      && (
        ctx.config.activeBrainrouterServer !== serverId
        || (options.persistHighlightedProfile === true && ctx.config.activeServer !== serverId)
      )
    ) {
      const previousActiveBrainrouterServer = ctx.config.activeBrainrouterServer;
      const previousActiveServer = ctx.config.activeServer;
      ctx.config.activeBrainrouterServer = serverId;
      if (options.persistHighlightedProfile === true) ctx.config.activeServer = serverId;
      try {
        (options.persistConfig ?? saveConfigOrThrow)(ctx.config);
      } catch (error) {
        ctx.config.activeBrainrouterServer = previousActiveBrainrouterServer;
        ctx.config.activeServer = previousActiveServer;
        throw new McpProfilePersistenceError(status, error);
      }
    }
    return status;
  } finally {
    pool.startReconnectSupervisor();
  }
}

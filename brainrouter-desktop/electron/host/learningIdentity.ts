/**
 * ADR-032 D8 — authenticated Desktop learning identity.
 *
 * Hosted tenant authority comes from the custom MCP host channel, never from
 * renderer input or stale account config. A configured BrainRouter profile is
 * fail-closed until that identity is verified; installations without one keep
 * the ordinary local learning partition.
 */
import { createHash } from 'node:crypto';
import type { ServerConfig } from '@kinqs/brainrouter-core/config';
import type { LearnedTenant } from '@kinqs/brainrouter-core/learning';
import type { HostLearningRequest, HostLearningResult } from '@kinqs/brainrouter-core/mcp';

type IdentityRequest = Extract<HostLearningRequest, { operation: 'identity' }>;

export interface DesktopLearningIdentityClient {
  callHostLearning(request: IdentityRequest): Promise<HostLearningResult | unknown>;
  getStatuses?(): Array<{ serverId: string; identity: string }>;
}

export interface DesktopLearningIdentityConfig {
  servers: Record<string, ServerConfig>;
  expectedUserId?: string;
  expectedOrgId?: string;
}

export interface DesktopLearningBinding {
  tenant: LearnedTenant;
  enabled: boolean;
  source: 'server' | 'local' | 'unresolved-authenticated-profile';
  warning?: string;
}

export function isBrainRouterLearningProfile(id: string, server: ServerConfig): boolean {
  if (server.identity) return server.identity === 'brainrouter';
  if (id.toLowerCase().startsWith('brainrouter')) return true;
  if (server.type === 'http' && server.url) {
    try {
      if (/\.brainrouter\.(cloud|dev|io|com|app)$/i.test(new URL(server.url).hostname)) return true;
    } catch { /* malformed URLs fail later at the transport boundary */ }
  }
  if (server.type === 'stdio') {
    const base = (server.command ?? '').split(/[/\\]/).pop() ?? '';
    return /^brainrouter(?:-mcp)?(?:\.cmd|\.exe)?$/i.test(base);
  }
  return false;
}

function configuredProfile(
  config: DesktopLearningIdentityConfig,
  client?: DesktopLearningIdentityClient,
): readonly [string, ServerConfig] | undefined {
  const statusBrainId = client?.getStatuses?.()
    .find((status) => status.identity === 'brainrouter')?.serverId;
  if (statusBrainId && config.servers[statusBrainId]) {
    return [statusBrainId, config.servers[statusBrainId]] as const;
  }
  return Object.entries(config.servers).find(([id, server]) => isBrainRouterLearningProfile(id, server));
}

function unresolvedBinding(id: string, server: ServerConfig, error?: unknown): DesktopLearningBinding {
  // The credential participates only in this one-way partition digest. This
  // prevents two hosted accounts at one endpoint sharing an outage partition.
  const digest = createHash('sha256')
    .update(JSON.stringify([id, server]))
    .digest('hex')
    .slice(0, 24);
  return {
    tenant: { userId: `unresolved-profile-${digest}`, orgId: null },
    enabled: false,
    source: 'unresolved-authenticated-profile',
    warning: error
      ? `Learning is disabled because the authenticated BrainRouter identity could not be verified: ${error instanceof Error ? error.message : String(error)}`
      : 'Learning is disabled until the authenticated BrainRouter identity is verified.',
  };
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return '';
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : '';
}

/** Synchronous boot binding used before any authenticated custom RPC resolves. */
export function initialDesktopLearningBinding(
  config: DesktopLearningIdentityConfig,
): DesktopLearningBinding {
  const profile = configuredProfile(config);
  if (!profile) {
    return { tenant: { userId: 'local', orgId: null }, enabled: true, source: 'local' };
  }
  return unresolvedBinding(profile[0], profile[1]);
}

/** Resolve and cross-check the server-pinned identity for the active profile. */
export async function resolveDesktopLearningBinding(input: {
  config: DesktopLearningIdentityConfig;
  mcpClient: DesktopLearningIdentityClient;
}): Promise<DesktopLearningBinding> {
  const profile = configuredProfile(input.config, input.mcpClient);
  if (!profile) {
    return { tenant: { userId: 'local', orgId: null }, enabled: true, source: 'local' };
  }

  try {
    const result = await input.mcpClient.callHostLearning({ operation: 'identity' });
    if ((result as { isError?: boolean })?.isError) {
      throw new Error(resultText(result) || 'identity RPC failed');
    }
    const parsed = JSON.parse(resultText(result)) as { userId?: unknown; orgId?: unknown };
    const userId = typeof parsed.userId === 'string' ? parsed.userId.trim() : '';
    const orgId = typeof parsed.orgId === 'string' ? parsed.orgId.trim() : parsed.orgId;
    if (!userId) throw new Error('identity RPC returned no user id');
    if (orgId !== null && typeof orgId !== 'string') {
      throw new Error('identity RPC returned an invalid organization id');
    }

    const expectedUserId = input.config.expectedUserId?.trim() ?? '';
    const expectedOrgId = input.config.expectedOrgId?.trim() ?? '';
    if (expectedUserId && expectedUserId !== userId) {
      throw new Error('the authenticated user does not match the configured account');
    }
    if (expectedOrgId && expectedOrgId !== (orgId || '')) {
      throw new Error('the authenticated organization does not match the configured account');
    }

    return {
      tenant: { userId, orgId: orgId || null },
      enabled: true,
      source: 'server',
    };
  } catch (error) {
    return unresolvedBinding(profile[0], profile[1], error);
  }
}

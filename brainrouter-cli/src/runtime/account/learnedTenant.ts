import { createHash } from 'node:crypto';
import type { ServerConfig } from '@kinqs/brainrouter-core/config';
import type { LearnedTenant } from '@kinqs/brainrouter-core/learning';

interface LearningIdentityClient {
  callHostLearning(request: { operation: 'identity' }): Promise<unknown>;
  getStatuses?(): Array<{ serverId: string; identity: string }>;
}

export interface CliLearnedTenantResolution {
  tenant: LearnedTenant;
  enabled: boolean;
  source: 'server' | 'local' | 'unresolved-authenticated-profile';
  warning?: string;
}

function isBrainRouterProfile(id: string, server: ServerConfig): boolean {
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

function profileFallbackTenant(id: string, server: ServerConfig): LearnedTenant {
  // Include the credential only inside the one-way digest. Two accounts at the
  // same endpoint must not collapse to one local partition during an outage.
  const material = JSON.stringify([id, server]);
  const digest = createHash('sha256').update(material).digest('hex').slice(0, 24);
  return { orgId: null, userId: `unresolved-profile-${digest}` };
}

function toolText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return '';
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === 'string' ? first.text : '';
}

/**
 * Pin the CLI Agent to the identity authenticated by the selected BrainRouter
 * MCP session. If an authenticated profile cannot prove that identity, learning
 * is disabled for this launch; falling back to `{personal,local}` would mix
 * different hosted accounts on one machine.
 */
export async function resolveCliLearnedTenant(input: {
  mcpClient: LearningIdentityClient;
  servers: Record<string, ServerConfig>;
}): Promise<CliLearnedTenantResolution> {
  const entries = Object.entries(input.servers);
  const statusBrainId = input.mcpClient.getStatuses?.()
    .find((status) => status.identity === 'brainrouter')?.serverId;
  const profile = (statusBrainId && input.servers[statusBrainId]
    ? [statusBrainId, input.servers[statusBrainId]] as const
    : entries.find(([id, server]) => isBrainRouterProfile(id, server)));

  if (!profile) {
    return { tenant: { orgId: null, userId: 'local' }, enabled: true, source: 'local' };
  }

  try {
    const result = await input.mcpClient.callHostLearning({ operation: 'identity' });
    if ((result as { isError?: boolean })?.isError) throw new Error(toolText(result) || 'identity RPC failed');
    const parsed = JSON.parse(toolText(result)) as { userId?: unknown; orgId?: unknown };
    const userId = typeof parsed.userId === 'string' ? parsed.userId.trim() : '';
    const orgId = typeof parsed.orgId === 'string' ? parsed.orgId.trim() : '';
    if (!userId) throw new Error('identity RPC returned no user id');
    return {
      tenant: { userId, orgId: orgId || null },
      enabled: true,
      source: 'server',
    };
  } catch (error) {
    return {
      tenant: profileFallbackTenant(profile[0], profile[1]),
      enabled: false,
      source: 'unresolved-authenticated-profile',
      warning: `learning disabled because the authenticated BrainRouter identity could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

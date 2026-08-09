import type { AgentCommand } from '@kinqs/brainrouter-agent-protocol';

export const INTERNAL_ACTIVE_ORG_QUERY_PREFIX = 'desktop-org-sync:';

type QueryCommand = Extract<AgentCommand, { kind: 'query' }>;
type HostSink = { postMessage(message: AgentCommand): void };

export function isActiveOrgSelectionQuery(command: AgentCommand): command is QueryCommand {
  return command.kind === 'query' && command.name === 'account-set-active-org';
}

/**
 * The active organization is app-global while every pooled workspace owns a
 * separate utility-process Agent and MCP pool. Send the renderer's original
 * query to its active host (so its normal query promise resolves), and send an
 * internal copy to every other live host. Duplicate host references are folded
 * and one dead host never prevents the rest from crossing the boundary.
 */
export function broadcastActiveOrgSelection(
  command: QueryCommand,
  activeHost: HostSink | undefined,
  liveHosts: Iterable<HostSink>,
  batchId: string,
): number {
  const unique = new Set<HostSink>();
  if (activeHost) unique.add(activeHost);
  for (const host of liveHosts) unique.add(host);

  let sent = 0;
  let ordinal = 0;
  for (const host of unique) {
    const forwarded = host === activeHost
      ? command
      : { ...command, id: `${INTERNAL_ACTIVE_ORG_QUERY_PREFIX}${batchId}:${++ordinal}` };
    try {
      host.postMessage(forwarded);
      sent += 1;
    } catch {
      // The host exit handler owns process recovery. Continue broadcasting so
      // every still-live host receives the tenant boundary.
    }
  }
  return sent;
}

/** Internal fan-out acknowledgements are main-process coordination traffic and
 * must never resolve an unrelated renderer query in another workspace/window. */
export function isInternalActiveOrgResult(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const event = (message as { event?: unknown }).event;
  if (!event || typeof event !== 'object') return false;
  const candidate = event as { kind?: unknown; id?: unknown };
  return candidate.kind === 'query-result'
    && typeof candidate.id === 'string'
    && candidate.id.startsWith(INTERNAL_ACTIVE_ORG_QUERY_PREFIX);
}

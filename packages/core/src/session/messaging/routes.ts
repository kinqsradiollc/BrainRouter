/**
 * ADR-034 one-address-space route selection.
 *
 * Discovery metadata may arrive from the local registry and the remote brain,
 * but identity is always the exact session key. A live local route replaces a
 * remote duplicate for that key; titles are deliberately absent from lookup.
 */

import type { SessionRouteDescriptor } from './contracts.js';
import { requireSessionKey } from './validation.js';

export function mergeSessionRoutes(
  local: readonly SessionRouteDescriptor[],
  remote: readonly SessionRouteDescriptor[],
): SessionRouteDescriptor[] {
  const merged = new Map<string, SessionRouteDescriptor>();
  for (const route of remote) addPreferredRoute(merged, route);
  for (const route of local) addPreferredRoute(merged, { ...route, transport: 'local' });
  return [...merged.values()]
    .map((route) => ({ ...route }))
    .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));
}

export function findSessionRouteByKey(
  routes: readonly SessionRouteDescriptor[],
  sessionKey: string,
): SessionRouteDescriptor | undefined {
  let exactKey: string;
  try {
    exactKey = requireSessionKey(sessionKey);
  } catch {
    return undefined;
  }
  const route = routes.find((candidate) => candidate.sessionKey === exactKey);
  return route ? { ...route } : undefined;
}

function addPreferredRoute(
  routes: Map<string, SessionRouteDescriptor>,
  candidate: SessionRouteDescriptor,
): void {
  let sessionKey: string;
  try {
    sessionKey = requireSessionKey(candidate.sessionKey);
  } catch {
    return;
  }
  const current = routes.get(sessionKey);
  if (!current || candidate.transport === 'local' && current.transport !== 'local' ||
      candidate.transport === current.transport && candidate.lastSeenAt > current.lastSeenAt) {
    routes.set(sessionKey, { ...candidate, sessionKey });
  }
}

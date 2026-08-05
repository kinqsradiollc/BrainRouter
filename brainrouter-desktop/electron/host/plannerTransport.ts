/**
 * ADR-028 D11 — the desktop's transport to the planner API.
 *
 * The piece that was missing. `planner-sync` counted pending operations and
 * returned the number — which looks like syncing and is not. The store, the
 * merge rules, the outbox and the backend all existed; nothing carried
 * operations between them, so the desktop planner has been local-only while
 * reporting a sync state.
 *
 * Pull-then-push (D11): pulling first means a push never overwrites something
 * it has not seen.
 */
import type { PlannerTransport } from '@kinqs/brainrouter-core/planner';

export interface TransportConfig {
  /** The brain base URL, e.g. http://localhost:3747. */
  baseUrl: string;
  /** Session or federation key for the API. */
  token?: string;
}

/**
 * A transport that talks to `/api/planner`.
 *
 * Network failures THROW, and `syncOnce` catches them into `offline: true`.
 * That distinction matters: offline is the normal mode that happens to be
 * syncing (D2), not an error to report — so it is classified where the outbox
 * can see it rather than swallowed here.
 */
export function createPlannerTransport(config: TransportConfig): PlannerTransport {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.token) headers.authorization = `Bearer ${config.token}`;

  return {
    async pull(since) {
      const url = new URL('/api/planner/items', config.baseUrl);
      if (since) url.searchParams.set('since', since);
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`planner pull failed: ${res.status}`);
      return await res.json() as Awaited<ReturnType<PlannerTransport['pull']>>;
    },
    async push(operations) {
      const res = await fetch(new URL('/api/planner/operations', config.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({ operations }),
      });
      if (!res.ok) throw new Error(`planner push failed: ${res.status}`);
      return await res.json() as Awaited<ReturnType<PlannerTransport['push']>>;
    },
  };
}

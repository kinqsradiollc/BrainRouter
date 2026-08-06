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
/**
 * Is this a base URL the main process should send planner content to?
 *
 * `brainUrl` comes from config, not from the web, so this is defence in depth
 * rather than a live hole — but the main process issuing arbitrary GET/POST
 * with planner content is exactly the sink SSRF is about. A config value that
 * pointed at a cloud metadata endpoint or a local admin panel would be sent
 * requests by a privileged process.
 *
 * Loopback over http, anything else over https. Nothing else.
 */
export function isAllowedBrainUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  // Plain http only for the machine you are on.
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
}

export function createPlannerTransport(config: TransportConfig): PlannerTransport {
  if (!isAllowedBrainUrl(config.baseUrl)) {
    throw new Error(
      `Refusing to sync the planner to "${config.baseUrl}" — plain http is allowed only for localhost.`,
    );
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.token) headers.authorization = `Bearer ${config.token}`;

  return {
    async pull(since) {
      const url = new URL('/api/planner/pull', config.baseUrl);
      if (since) url.searchParams.set('since', since);
      // `manual` so a redirect cannot move the request to a host the check
      // above approved and the server then changed.
      const res = await fetch(url, { headers, redirect: 'manual' });
      if (!res.ok) throw new Error(`planner pull failed: ${res.status}`);
      const body = await res.json() as { items?: unknown };
      if (!body || !Array.isArray(body.items)) {
        throw new Error('planner pull returned a body that is not a planner response');
      }
      return body as Awaited<ReturnType<PlannerTransport['pull']>>;
    },
    async push(operations) {
      const res = await fetch(new URL('/api/planner/push', config.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({ operations }),
        redirect: 'manual',
      });
      if (!res.ok) throw new Error(`planner push failed: ${res.status}`);
      const body = await res.json() as { accepted?: unknown; rejected?: unknown };
      if (!body || !Array.isArray(body.accepted) || !Array.isArray(body.rejected)) {
        throw new Error('planner push returned a body that is not a planner response');
      }
      return body as Awaited<ReturnType<PlannerTransport['push']>>;
    },
  };
}

/**
 * ADR-029 B3 — the desktop's transport to `/api/notes`.
 *
 * Notes reuse the planner's sync stack unchanged, so this is the planner's
 * transport with two endpoints swapped. It is a separate file rather than a
 * parameter on the planner's because the SSRF check below has to be read at
 * every call site that sends a user's content somewhere, and burying it behind
 * a `resource` argument is how it stops being read.
 */
import type { NotesTransport } from '@kinqs/brainrouter-core/notes';
import { isAllowedBrainUrl } from './plannerTransport.js';

export interface NotesTransportConfig {
  /** The brain base URL, e.g. http://localhost:3747. */
  baseUrl: string;
  /** Session or federation key for the API. */
  token?: string;
}

export function createNotesTransport(config: NotesTransportConfig): NotesTransport {
  // The main process issuing arbitrary requests carrying a person's notes is
  // exactly the sink SSRF is about. `brainUrl` comes from config rather than
  // from the web, so this is defence in depth — but a config value pointing at
  // a metadata endpoint or a local admin panel would be sent notes by a
  // privileged process.
  if (!isAllowedBrainUrl(config.baseUrl)) {
    throw new Error(
      `Refusing to sync notes to "${config.baseUrl}" — plain http is allowed only for localhost.`,
    );
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.token) headers.authorization = `Bearer ${config.token}`;

  return {
    async pull(since) {
      const url = new URL('/api/notes/pull', config.baseUrl);
      if (since) url.searchParams.set('since', since);
      // `manual` so a redirect cannot move the request to a host the check
      // above approved and the server then changed.
      const res = await fetch(url, { headers, redirect: 'manual' });
      if (!res.ok) throw new Error(`notes pull failed: ${res.status}`);
      const body = await res.json() as { items?: unknown };
      if (!body || !Array.isArray(body.items)) {
        throw new Error('notes pull returned a body that is not a notes response');
      }
      return body as Awaited<ReturnType<NotesTransport['pull']>>;
    },
    async push(operations) {
      const res = await fetch(new URL('/api/notes/push', config.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({ operations }),
        redirect: 'manual',
      });
      if (!res.ok) throw new Error(`notes push failed: ${res.status}`);
      const body = await res.json() as { accepted?: unknown; rejected?: unknown };
      if (!body || !Array.isArray(body.accepted) || !Array.isArray(body.rejected)) {
        throw new Error('notes push returned a body that is not a notes response');
      }
      return body as Awaited<ReturnType<NotesTransport['push']>>;
    },
  };
}

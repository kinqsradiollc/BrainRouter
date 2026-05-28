/**
 * Streamable HTTP MCP `Accept` header tolerance.
 *
 * The MCP SDK strictly requires every POST to advertise both
 * `application/json` and `text/event-stream` because the response
 * can be either a plain JSON body or an SSE stream. Naive clients
 * (curl, fetch without explicit headers, older MCP SDK builds,
 * some health-check probes) routinely send only one, triggering
 * the noisy `Not Acceptable: Client must accept both` error in
 * production logs.
 *
 * This module decides whether the brain should transparently
 * promote a partial Accept header. Promotion is safe — the SDK
 * only enters SSE mode when the handler explicitly streams the
 * response, which the JSON-only request shapes naive clients send
 * never trigger.
 *
 * Lives outside `index.ts` so vitest can test the decision in
 * isolation (importing `index.js` pulls the sqlite-vec dependency
 * graph that vite's resolver doesn't handle).
 */

export interface AcceptPromotion {
  promote: true;
  value: string;
}

export interface AcceptKept {
  promote: false;
}

export type AcceptDecision = AcceptPromotion | AcceptKept;

const PROMOTED_VALUE = 'application/json, text/event-stream';

/**
 * Decide whether to overwrite `Accept` so the Streamable HTTP MCP
 * SDK accepts the POST.
 *
 * Cases:
 *   - already accepts text/event-stream    → no change
 *   - accept is empty                       → promote
 *   - accept is `*​/*`                       → promote (caller wins)
 *   - accept is exactly application/json    → promote (common miss)
 *   - accept is multi-value with json       → promote
 *   - accept is any other narrow type       → DO NOT promote; SDK's 406 is right
 */
export function decideMcpAcceptPromotion(accept: string): AcceptDecision {
  const trimmed = (accept ?? '').trim();
  if (/\btext\/event-stream\b/i.test(trimmed)) return { promote: false };
  if (trimmed === '' || trimmed === '*/*') {
    return { promote: true, value: PROMOTED_VALUE };
  }
  if (/^application\/json\s*(;.*)?$/i.test(trimmed)) {
    return { promote: true, value: PROMOTED_VALUE };
  }
  const tokens = trimmed.split(',').map((t) => t.split(';')[0].trim().toLowerCase());
  if (tokens.includes('application/json')) {
    return { promote: true, value: PROMOTED_VALUE };
  }
  return { promote: false };
}

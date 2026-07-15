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
 * SDK accepts the POST. The SDK's POST rule requires the header to
 * advertise BOTH `application/json` AND `text/event-stream` — a
 * request carrying only one of them is 406'd.
 *
 * Cases:
 *   - already lists BOTH json AND event-stream → no change (SDK is happy)
 *   - accept is empty                          → promote
 *   - accept is `*​/*`                          → promote (caller wins)
 *   - accept lists application/json only        → promote (common miss)
 *   - accept lists text/event-stream only       → promote (add the missing json;
 *                                                 a streaming client that reaches
 *                                                 /mcp otherwise 406s — see the
 *                                                 desktop provider transport)
 *   - accept is multi-value with json           → promote
 *   - accept is any other narrow type           → DO NOT promote; SDK's 406 is right
 */
export function decideMcpAcceptPromotion(accept: string): AcceptDecision {
  const trimmed = (accept ?? '').trim();
  const hasEventStream = /\btext\/event-stream\b/i.test(trimmed);
  const hasJson = /\bapplication\/json\b/i.test(trimmed);
  // Already satisfies the SDK's dual-Accept POST rule — leave it untouched.
  if (hasEventStream && hasJson) return { promote: false };
  if (trimmed === '' || trimmed === '*/*') {
    return { promote: true, value: PROMOTED_VALUE };
  }
  // Carries exactly one of the two required types (json-only OR event-stream-only)
  // — promote to the full dual value so the SDK accepts the POST.
  if (hasJson || hasEventStream) {
    return { promote: true, value: PROMOTED_VALUE };
  }
  return { promote: false };
}

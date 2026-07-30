/**
 * WS9 — pure scheduling helper for the pool's background auto-reconnect
 * supervisor. Kept separate from the pool class so the "who is due?" decision
 * is unit-testable without a live pool.
 */

/** WS9 — pure: which pool servers are due for a background auto-reconnect now? A
 *  server is due when it isn't connected/connecting and its per-server backoff
 *  window has elapsed. Returns the serverIds to retry this tick. */
export function dueForReconnect(
  statuses: ReadonlyArray<{ serverId: string; status: string }>,
  nextAt: ReadonlyMap<string, number>,
  now: number,
): string[] {
  const due: string[] = [];
  for (const s of statuses) {
    if (s.status === 'connected' || s.status === 'connecting') continue;
    if (now >= (nextAt.get(s.serverId) ?? 0)) due.push(s.serverId);
  }
  return due;
}

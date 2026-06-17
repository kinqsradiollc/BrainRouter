/**
 * Wave 2 (E) — session list ordering + new-chat optimism.
 *
 * Two correctness rules the sidebar must obey:
 *  1. Order is ACTIVITY-derived (transcript mtime, host-sorted). Merely opening
 *     /resuming/viewing a session is read-only, so a refresh with the same data
 *     reproduces the same order — `mergeOptimistic(host, [])` === `host`.
 *  2. A brand-new chat's row must appear the instant the user sends, and must
 *     NOT vanish when a `list-sessions` refresh races the transcript flush.
 *     `mergeOptimistic` keeps optimistic rows until the host list confirms them.
 * Pure + unit-tested.
 */
export interface SessionLike { sessionKey: string }

/** Host-confirmed rows + any optimistic rows not yet present (newest-first).
 *  Once the host includes an optimistic row's key, the host copy wins (no dup). */
export function mergeOptimistic<T extends SessionLike>(hostRows: T[], optimistic: T[]): T[] {
  const have = new Set(hostRows.map((r) => r.sessionKey));
  const extra = optimistic.filter((o) => !have.has(o.sessionKey));
  return [...extra, ...hostRows];
}

/** Optimistic keys the host now confirms — drop these from the pending set. */
export function confirmedKeys(hostRows: SessionLike[], optimisticKeys: string[]): string[] {
  const have = new Set(hostRows.map((r) => r.sessionKey));
  return optimisticKeys.filter((k) => have.has(k));
}

/** Drop confirmed (and any) keys from the pending optimistic list. */
export function dropPending<T extends SessionLike>(pending: T[], keys: string[]): T[] {
  const drop = new Set(keys);
  return pending.filter((p) => !drop.has(p.sessionKey));
}

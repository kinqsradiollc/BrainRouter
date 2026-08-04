/**
 * ADR-028 D7 + D8 — sources behind one interface, and what happens to old items.
 *
 * Every source does three things: list candidates, map them to a planner item,
 * and report how fresh that answer is. The first set is Track, GitHub issues,
 * GitHub PRs, review findings, meeting actions, and manual entry.
 *
 * **A stale source says so.** If GitHub has been unreachable for six hours, the
 * view says the GitHub items are six hours old rather than presenting them as
 * current. This is the same commitment B1 makes about receipts: a surface may
 * not claim a state it has not established, and "here is your work" from a
 * source that has not answered since breakfast is exactly that claim.
 */
import type { PlannerItem } from './itemMerge.js';

export interface SourceFreshness {
  sourceId: string;
  /** When this source last answered successfully. */
  lastFetchedAt: string | null;
  /** Set when the last attempt failed. */
  lastError?: string;
  /** How many items came from that last successful read. */
  itemCount: number;
}

export interface SourceAdapter {
  id: string;
  /** Shown in the UI and in the agent's context summary. */
  label: string;
  /** True when items from here are mirrors of an external truth (D1). */
  mirrored: boolean;
  list(): Promise<PlannerItem[]>;
}

/** Beyond this, items are old enough that presenting them as current misleads. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

export function isStale(freshness: SourceFreshness, nowMs: number): boolean {
  if (!freshness.lastFetchedAt) return true;
  return nowMs - Date.parse(freshness.lastFetchedAt) > STALE_AFTER_MS;
}

/**
 * What the view says about a source.
 *
 * Age in words, because "last fetched 2026-08-04T09:12:00Z" makes a person do
 * arithmetic to answer the only question they have, which is whether to trust
 * what they are looking at.
 */
export function describeFreshness(freshness: SourceFreshness, nowMs: number): string {
  if (freshness.lastError && !freshness.lastFetchedAt) {
    return `${freshness.sourceId} has never loaded — ${freshness.lastError}`;
  }
  if (!freshness.lastFetchedAt) return `${freshness.sourceId} has not loaded yet.`;

  const ageMs = nowMs - Date.parse(freshness.lastFetchedAt);
  const age = describeAge(ageMs);
  if (freshness.lastError) {
    return `${freshness.sourceId} is ${age} old — the last refresh failed (${freshness.lastError}).`;
  }
  if (ageMs > STALE_AFTER_MS) return `${freshness.sourceId} is ${age} old.`;
  return `${freshness.sourceId} is current.`;
}

function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * Collect from every source without letting one failure empty the view.
 *
 * A source that throws contributes its error to freshness and nothing to the
 * list. Propagating instead would mean GitHub being down hides your local
 * todos, which is both useless and hard to understand from the outside.
 */
export async function collectFromSources(
  adapters: readonly SourceAdapter[],
  previous: readonly SourceFreshness[],
  nowIso: string,
): Promise<{ items: PlannerItem[]; freshness: SourceFreshness[] }> {
  const priorById = new Map(previous.map((f) => [f.sourceId, f]));
  const items: PlannerItem[] = [];
  const freshness: SourceFreshness[] = [];

  for (const adapter of adapters) {
    const prior = priorById.get(adapter.id);
    try {
      const listed = await adapter.list();
      items.push(...listed);
      freshness.push({ sourceId: adapter.id, lastFetchedAt: nowIso, itemCount: listed.length });
    } catch (error) {
      // Keep the last good fetch time: the items on screen ARE that old, and
      // resetting it to null would say we have nothing when we have something
      // stale, which is a different and less useful statement.
      freshness.push({
        sourceId: adapter.id,
        lastFetchedAt: prior?.lastFetchedAt ?? null,
        itemCount: prior?.itemCount ?? 0,
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { items, freshness };
}

/* --------------------------------------------------------- D8 · retention */

/**
 * Completed items keep full detail for 90 days, then compact.
 *
 * The planner is a working surface, not an archive. Following ADR-027 D11
 * rather than inventing a second retention policy — two policies for the same
 * kind of data is how one of them ends up wrong and nobody notices.
 */
export const DETAIL_RETENTION_DAYS = 90;

export interface CompactedItem {
  id: string;
  title: string;
  completedAt: string;
  /** Kept because drift feeds ADR-027 D1's ledgers. */
  estimateMinutes?: number;
  actualMinutes?: number;
}

/**
 * Split completed items into those keeping detail and those to compact.
 *
 * Compaction keeps the title, the completion date, and the estimate-versus-
 * actual — because consistent overruns are technical-debt evidence, and that
 * signal outlives the notes it came with.
 */
export function partitionForRetention(
  items: readonly (PlannerItem & { completedAt?: string; estimateMinutes?: number; actualMinutes?: number })[],
  nowMs: number,
  retentionDays = DETAIL_RETENTION_DAYS,
): { keep: PlannerItem[]; compact: CompactedItem[] } {
  const cutoff = nowMs - retentionDays * 86_400_000;
  const keep: PlannerItem[] = [];
  const compact: CompactedItem[] = [];

  for (const item of items) {
    if (!item.completedAt || Date.parse(item.completedAt) > cutoff) {
      keep.push(item);
      continue;
    }
    compact.push({
      id: item.id,
      title: item.title.value,
      completedAt: item.completedAt,
      ...(item.estimateMinutes !== undefined ? { estimateMinutes: item.estimateMinutes } : {}),
      ...(item.actualMinutes !== undefined ? { actualMinutes: item.actualMinutes } : {}),
    });
  }
  return { keep, compact };
}

/**
 * ADR-028 D7 — sources behind one interface.
 *
 * (D8's client-side half lived here too and is retired at the foot of the file;
 * retention runs on the server, which is where the rows are.)
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
  /** What to call it in front of a person; `sourceId` when the source had no name. */
  label?: string;
  /**
   * How long this source may go unanswered before saying so, when it refreshes
   * itself on a cadence (ADR-060 D5: twice that cadence). Absent, the shared
   * default applies — which suits a source read as part of a turn, not one
   * polled in the background.
   */
  staleAfterMs?: number;
}

export interface SourceAdapter {
  id: string;
  /** Shown in the UI and in the agent's context summary. */
  label: string;
  /** True when items from here are mirrors of an external truth (D1). */
  mirrored: boolean;
  /** Actual source fetch time when records came from an existing ingest cache. */
  lastFetchedAt?: string | null;
  list(): Promise<PlannerItem[]>;
}

/** Beyond this, items are old enough that presenting them as current misleads. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

export function isStale(freshness: SourceFreshness, nowMs: number): boolean {
  if (!freshness.lastFetchedAt) return true;
  return nowMs - Date.parse(freshness.lastFetchedAt) > (freshness.staleAfterMs ?? STALE_AFTER_MS);
}

/**
 * What the view says about a source.
 *
 * Age in words, because "last fetched 2026-08-04T09:12:00Z" makes a person do
 * arithmetic to answer the only question they have, which is whether to trust
 * what they are looking at.
 */
export function describeFreshness(freshness: SourceFreshness, nowMs: number): string {
  const name = freshness.label ?? freshness.sourceId;
  if (freshness.lastError && !freshness.lastFetchedAt) {
    return `${name} has never loaded — ${freshness.lastError}`;
  }
  if (!freshness.lastFetchedAt) return `${name} has not loaded yet.`;

  const ageMs = nowMs - Date.parse(freshness.lastFetchedAt);
  const age = describeAge(ageMs);
  if (freshness.lastError) {
    return `${name} is ${age} old — the last refresh failed (${freshness.lastError}).`;
  }
  // The same bar `isStale` uses, so a source cannot be listed as stale and then
  // described as current.
  if (ageMs > (freshness.staleAfterMs ?? STALE_AFTER_MS)) return `${name} is ${age} old.`;
  return `${name} is current.`;
}

function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

/*
 * `collectFromSources` fanned out over several adapters and folded their
 * failures into freshness. **Retired 2026-08-12**, with no caller, because
 * there is nowhere to fan out FROM: one adapter exists
 * (`createConnectorIssueSourceAdapter`), the server invokes it directly at
 * `brainrouter/src/memory/planner/backend.ts:547`, and the freshness the model
 * and the panels actually read is derived from the ITEMS —
 * `agentContext.sourceFreshnessFromItems`, which runs on every turn. Two ways
 * to compute freshness, one of them reached; D7 keeps the reached one.
 *
 * `partitionForRetention`, `CompactedItem` and `DETAIL_RETENTION_DAYS` (D8) go
 * with it. Retention ships, and it ships server-side:
 * `compactCompletedPlannerItems` inside `runRetentionPass`, driven hourly by
 * `MemoryJobRunner.maybeRunRetention`. A second client-side split of the same
 * rows with its own 90-day constant is the drift D8 warned about, written by
 * D8.
 */

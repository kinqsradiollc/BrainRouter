import type { MemoryListItem } from "@kinqs/brainrouter-types";

/**
 * 0.4.3 (MEM-11) — governance dry-run planner.
 *
 * Pure: given the active (non-archived) memory list + a filter, report which
 * records WOULD be archived/deleted, with counts by type, a rough size proxy,
 * and a sample of ids — WITHOUT mutating anything. The MCP tool
 * `memory_governance_plan` wraps this so users can preview a cleanup before
 * running the destructive `memory_governance_delete`.
 */

export interface GovernancePlanFilters {
  /** Restrict to one memory type (e.g. "codebase_fact"). */
  type?: string;
  /** Only records created more than N days ago. */
  olderThanDays?: number;
  /** Only records that have never been cited. */
  uncitedOnly?: boolean;
}

export interface GovernancePlanResult {
  matched: number;
  byType: Record<string, number>;
  /** Sum of content lengths — a rough proxy for reclaimable size. */
  estimatedChars: number;
  /** Up to 20 candidate record ids (oldest-first as returned by the store). */
  sampleRecordIds: string[];
  filters: GovernancePlanFilters;
}

export function planGovernance(
  items: MemoryListItem[],
  filters: GovernancePlanFilters,
  nowMs: number,
): GovernancePlanResult {
  const cutoff = filters.olderThanDays != null ? nowMs - filters.olderThanDays * 86_400_000 : null;
  const matched = items.filter((m) => {
    if (filters.type && m.type !== filters.type) return false;
    if (filters.uncitedOnly && m.citationCount > 0) return false;
    if (cutoff != null) {
      const t = Date.parse(m.createdTime);
      if (!Number.isFinite(t) || t > cutoff) return false; // newer than cutoff (or unparseable) → exclude
    }
    return true;
  });

  const byType: Record<string, number> = {};
  let estimatedChars = 0;
  for (const m of matched) {
    byType[m.type] = (byType[m.type] ?? 0) + 1;
    estimatedChars += (m.content ?? "").length;
  }

  return {
    matched: matched.length,
    byType,
    estimatedChars,
    sampleRecordIds: matched.slice(0, 20).map((m) => m.recordId),
    filters,
  };
}

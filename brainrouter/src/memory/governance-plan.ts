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

/**
 * MEM-21 (0.4.4) — storage-governance dry-run beyond cognitive records.
 *
 * 0.4.3's plan covered cognitive records only. This extends the preview to the
 * 0.4.3 depth tables — source documents/chunks, memory-tree nodes, and the
 * vault-export ledger — reporting how much each class holds and how much is
 * SAFELY reclaimable (e.g. only orphaned source chunks, not those still backing
 * a live memory). Pure: the store supplies the counts, this turns them into a
 * per-class plan + totals. (Working-memory offloads live CLI-side, not in this
 * store; MEM-22's reclaimer governs those.)
 */
export interface StorageGovernanceStats {
  sourceDocuments: number;
  sourceChunks: { count: number; chars: number; orphanCount: number; orphanChars: number };
  treeNodes: { count: number; chars: number };
  vaultExports: number;
}

export interface StorageGovernanceClass {
  class: string;
  count: number;
  estimatedChars: number;
  /** The subset of estimatedChars that is safe to reclaim now. */
  reclaimableChars: number;
  note: string;
}

export interface StorageGovernanceResult {
  classes: StorageGovernanceClass[];
  totalEstimatedChars: number;
  totalReclaimableChars: number;
}

export function planStorageGovernance(stats: StorageGovernanceStats): StorageGovernanceResult {
  const classes: StorageGovernanceClass[] = [
    {
      class: "source_chunks",
      count: stats.sourceChunks.count,
      estimatedChars: stats.sourceChunks.chars,
      // Only chunks NOT cited by a live memory's provenance are safe to prune.
      reclaimableChars: stats.sourceChunks.orphanChars,
      note: `${stats.sourceChunks.orphanCount} of ${stats.sourceChunks.count} chunks orphaned (not cited by a live memory) → safe to prune via memory_prune_sources`,
    },
    {
      class: "source_documents",
      count: stats.sourceDocuments,
      estimatedChars: 0,
      reclaimableChars: 0,
      note: "documents are reclaimed together with their orphaned chunks",
    },
    {
      class: "tree_nodes",
      count: stats.treeNodes.count,
      estimatedChars: stats.treeNodes.chars,
      reclaimableChars: 0,
      note: "durable summaries — reported only, not auto-reclaimed",
    },
    {
      class: "vault_exports",
      count: stats.vaultExports,
      estimatedChars: 0,
      reclaimableChars: 0,
      note: "ledger entries for regenerable off-DB markdown files; re-export is idempotent",
    },
  ];
  return {
    classes,
    totalEstimatedChars: classes.reduce((a, c) => a + c.estimatedChars, 0),
    totalReclaimableChars: classes.reduce((a, c) => a + c.reclaimableChars, 0),
  };
}

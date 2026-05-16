import type { L1Record } from "../types.js";
import type { SqliteMemoryStore } from "../store/sqlite.js";

/**
 * Result of the deduplication process
 */
export interface DedupResult {
  /** Memories that are unique and should be stored */
  uniqueRecords: L1Record[];
  /** Memories that were identified as exact duplicates and dropped */
  droppedCount: number;
}

/**
 * Proactively deduplicate extracted memories against the existing memory store
 * before they are stored.
 * 
 * Uses exact/near-exact string matching to prevent identical noisy facts 
 * from accumulating in the L1 store.
 */
export async function deduplicateMemories(params: {
  records: L1Record[];
  store: SqliteMemoryStore;
  userId: string;
}): Promise<DedupResult> {
  const { records, store, userId } = params;
  
  if (records.length === 0) {
    return { uniqueRecords: [], droppedCount: 0 };
  }

  const uniqueRecords: L1Record[] = [];
  let droppedCount = 0;

  for (const newRecord of records) {
    // 1. Keyword search to find potentially identical memories
    // We only need top 3 to see if there is an exact match
    const candidates = store.searchL1Fts(userId, newRecord.content, 3);
    
    let isDuplicate = false;
    
    for (const candidate of candidates) {
      // Direct string comparison (case-insensitive, trimmed)
      if (candidate.content.trim().toLowerCase() === newRecord.content.trim().toLowerCase()) {
        isDuplicate = true;
        break;
      }
    }

    if (isDuplicate) {
      console.log(`[BrainRouter] Dropped exact duplicate memory: "${newRecord.content}"`);
      droppedCount++;
    } else {
      uniqueRecords.push(newRecord);
    }
  }

  return {
    uniqueRecords,
    droppedCount
  };
}

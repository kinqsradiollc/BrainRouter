import type { SqliteMemoryStore } from "../store/sqlite.js";
import type { LLMRunner, L1Record } from "../types.js";
import { L1_CONTRADICTION_PROMPT } from "../prompts/l1-contradiction.js";
import crypto from "node:crypto";

export async function detectContradictions(params: {
  newRecord: L1Record;
  store: SqliteMemoryStore;
  llmRunner: LLMRunner;
}) {
  const { newRecord, store, llmRunner } = params;

  // 1. Search for potentially related memories
  // We use keyword search on the content of the new record to find similar existing ones
  const candidates = store.searchL1Fts(newRecord.userId, newRecord.content, 5);
  
  for (const candidate of candidates) {
    // Don't compare with self
    if (candidate.record_id === newRecord.id) continue;

    // Only compare if they are of the same type or both are episodic/persona
    // (instructions don't usually contradict episodic facts)
    
    const prompt = L1_CONTRADICTION_PROMPT
      .replace("{{newContent}}", newRecord.content)
      .replace("{{existingContent}}", candidate.content);

    try {
      const response = await llmRunner.run({
        prompt,
        taskId: `contradiction-check-${newRecord.id}-${candidate.record_id}`,
        timeoutMs: 30000
      });

      // Simple JSON extraction (flexible for local models)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const data = JSON.parse(jsonMatch[0]);
      if (data.isContradiction && data.confidence > 0.7) {
        console.error(`[BrainRouter] CONTRADICTION DETECTED: ${newRecord.id} vs ${candidate.record_id}`);
        
        store.upsertContradiction({
          id: `conflict_${crypto.randomBytes(4).toString("hex")}`,
          userId: newRecord.userId,
          recordIdA: candidate.record_id,
          recordIdB: newRecord.id,
          reason: data.reason,
          confidence: data.confidence
        });
      }
    } catch (e) {
      console.error(`[BrainRouter] Contradiction check failed for ${newRecord.id} vs ${candidate.record_id}:`, (e as Error).message);
    }
  }
}

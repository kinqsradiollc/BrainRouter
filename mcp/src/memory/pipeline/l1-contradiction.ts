import type { IMemoryStore } from "@brainrouter/types";
import type { LLMRunner, L1Record, L1FtsResult } from "@brainrouter/types";
import { L1_CONTRADICTION_PROMPT } from "../prompts/l1-contradiction.js";
import crypto from "node:crypto";

export async function detectContradictions(params: {
  newRecord: L1Record;
  store: IMemoryStore;
  llmRunner: LLMRunner;
}) {
  const { newRecord, store, llmRunner } = params;

  // 1. Search for potentially related memories
  // We use keyword search on the content of the new record to find similar existing ones
  const candidates = store.searchL1Fts(newRecord.userId, newRecord.content, 5);
  
  const evaluations: Array<{
    candidate: L1FtsResult;
    isContradiction: boolean;
    confidence: number;
    kind: "temporal_update" | "genuine_conflict";
    reason: string;
  }> = [];

  const _parsedContradictionTimeout = parseInt(process.env.BRAINROUTER_CONTRADICTION_TIMEOUT_MS || "", 10);
  const contradictionTimeoutMs = isNaN(_parsedContradictionTimeout) ? 60000 : _parsedContradictionTimeout;

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
        timeoutMs: contradictionTimeoutMs
      });

      // Simple JSON extraction (flexible for local models)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const data = JSON.parse(jsonMatch[0]);
      if (data.isContradiction && data.confidence > 0.7) {
        evaluations.push({
          candidate,
          isContradiction: true,
          confidence: data.confidence,
          kind: data.kind || "genuine_conflict",
          reason: data.reason
        });
      }
    } catch (e) {
      console.error(`[BrainRouter] Contradiction check failed for ${newRecord.id} vs ${candidate.record_id}:`, (e as Error).message);
    }
  }

  // If ANY evaluation is a temporal_update, then the entire batch of contradictions represents a temporal transition!
  const hasTemporalUpdate = evaluations.some(ev => ev.kind === "temporal_update");

  for (const ev of evaluations) {
    if (hasTemporalUpdate) {
      // Treat all conflicting old records as superseded by the new record
      console.error(`[BrainRouter] TEMPORAL UPDATE DETECTED (transition): Superseding memory ${ev.candidate.record_id} with new memory ${newRecord.id}`);
      store.invalidateL1Record(newRecord.userId, ev.candidate.record_id, newRecord.id);
    } else {
      // Genuine conflict
      console.error(`[BrainRouter] CONTRADICTION DETECTED: ${newRecord.id} vs ${ev.candidate.record_id}`);
      
      store.upsertContradiction({
        id: `conflict_${crypto.randomBytes(4).toString("hex")}`,
        userId: newRecord.userId,
        recordIdA: ev.candidate.record_id,
        recordIdB: newRecord.id,
        reason: ev.reason,
        confidence: ev.confidence
      });
    }
  }
}

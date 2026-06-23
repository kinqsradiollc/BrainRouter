import type { IMemoryStore } from "@kinqs/brainrouter-types";
import type { LLMRunner, CognitiveRecord, CognitiveFtsResult } from "@kinqs/brainrouter-types";
import { COGNITIVE_CONTRADICTION_PROMPT } from "../prompts/cognitive-contradiction.js";
import { extractJsonValue } from "../util/llm-json.js";
import crypto from "node:crypto";

export async function detectContradictions(params: {
  newRecord: CognitiveRecord;
  store: IMemoryStore;
  llmRunner: LLMRunner;
}) {
  const { newRecord, store, llmRunner } = params;

  // 1. Search for potentially related memories. Each candidate costs ONE serial
  // LLM call, so a high fan-out (×5 per record × N records per capture) was a
  // major contributor to the background contradiction-check timeouts. Cap it
  // (default 3, tunable) to bound the per-record LLM load.
  const _parsedMaxCand = parseInt(process.env.BRAINROUTER_CONTRADICTION_MAX_CANDIDATES || "", 10);
  const maxCandidates = isNaN(_parsedMaxCand) || _parsedMaxCand < 1 ? 3 : _parsedMaxCand;
  const candidates = await store.searchCognitiveFts(newRecord.userId, newRecord.content, maxCandidates);
  
  const evaluations: Array<{
    candidate: CognitiveFtsResult;
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

    const prompt = COGNITIVE_CONTRADICTION_PROMPT
      .replace("{{newContent}}", newRecord.content)
      .replace("{{existingContent}}", candidate.content);

    try {
      const response = await llmRunner.run({
        prompt,
        taskId: `contradiction-check-${newRecord.id}-${candidate.record_id}`,
        timeoutMs: contradictionTimeoutMs
      });

      // Robust parse: tolerant of role-token leaks / prose / fences (see llm-json.ts).
      const data: any = extractJsonValue(response, { kind: "object" });
      if (!data) continue;
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

  const hasTemporalUpdate = evaluations.some(ev => ev.kind === "temporal_update");

  for (const ev of evaluations) {
    if (hasTemporalUpdate) {
      console.error(`[BrainRouter] TEMPORAL UPDATE DETECTED (transition): Superseding memory ${ev.candidate.record_id} with new memory ${newRecord.id}`);
      await store.invalidateCognitiveRecord(newRecord.userId, ev.candidate.record_id, newRecord.id);
    } else {
      console.error(`[BrainRouter] CONTRADICTION DETECTED: ${newRecord.id} vs ${ev.candidate.record_id}`);
      
      await store.upsertContradiction({
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

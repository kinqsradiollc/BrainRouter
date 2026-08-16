import type { SensoryRecord, CaptureResult, CognitiveExtractionStatus } from "@kinqs/brainrouter-types";
import { redactSensitiveMemoryText } from "../util/redaction.js";
import crypto from "node:crypto";
import { CaptureExtraction } from "./extraction.js";
import { normalizeMemoryTags } from "./memoryTags.js";

/**
 * Capture entry point: the public `MemoryCapturePipeline`. `captureTurn` writes
 * the sensory rows + source docs synchronously and dispatches cognitive
 * extraction (inline or background); `processBacklog` re-runs the pending sweep.
 * Both delegate into the persistence + extraction concerns via the class chain.
 * Method bodies are moved byte-identically from the original god file.
 */
export class MemoryCapturePipeline extends CaptureExtraction {
  public async captureTurn(params: {
    userId: string;
    sessionKey: string;
    sessionId?: string;
    messages: { role: string; content: string; timestamp: number }[];
    activeSkill?: string;
    skillHints?: string;
    memoryTags?: string[];
    orgId?: string | null;
    projectId?: string | null;
    workspaceTag?: string | null;
    projectTag?: string | null;
  }): Promise<CaptureResult> {
    const { userId, sessionKey, sessionId = "", messages, activeSkill, skillHints, memoryTags, orgId, projectId, workspaceTag, projectTag } = params;

    const nowStr = new Date().toISOString();
    const sensoryRecords: SensoryRecord[] = [];
    const normalizedMemoryTags = normalizeMemoryTags(memoryTags ?? []);

    // 1. Write Sensory Records atomically
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const record: SensoryRecord = {
        id: `sensory_${sessionKey}_${msg.timestamp}_${i}_${crypto.randomBytes(3).toString("hex")}`,
        userId,
        sessionKey,
        sessionId,
        role: msg.role,
        messageText: redactSensitiveMemoryText(msg.content),
        recordedAt: nowStr,
        timestamp: msg.timestamp,
        skillTag: activeSkill || "",
        ...(normalizedMemoryTags.length > 0 ? { memoryTags: [...normalizedMemoryTags] } : {}),
      };

      await this.store.upsertSensory(record);
      sensoryRecords.push(record);
    }

    // 1b. MEM-2′ — token-aware source capture. Persist each substantial turn
    // message as a source document + chunks so the raw content stays
    // retrievable and citable (record→chunk provenance lands in MEM-3).
    // Best-effort + idempotent; never blocks the rest of the turn.
    await this.ingestTurnSources(userId, sessionKey, messages, { orgId, projectId, workspaceTag, projectTag });

    // 2. Decide if we should trigger Cognitive extraction
    const unextractedCount = await this.store.getUnextractedSensoryCount(userId, sessionKey);

    let cognitiveExtractionTriggered = false;
    let cognitiveExtractedCount = 0;
    let cognitiveExtractionStatus: CaptureResult["cognitiveExtractionStatus"] = "skipped";
    let cognitiveExtractionError: string | undefined;

    if (unextractedCount >= this.extractEveryNTurns) {
      // MEM-NONBLOCK — extraction is a slow, network-bound LLM chain (extract →
      // dedup → per-record graph/contradiction/focus) that the caller never
      // consumes. Running it inline blocked the MCP reply for up to the LLM
      // timeout (2 min cloud / 10 min local), so a client that disconnected
      // sooner caused "Dropped MCP response (client disconnected before reply)".
      // The sensory rows the caller cares about are already written above, so
      // dispatch extraction in the BACKGROUND (guarded against concurrent
      // double-extraction) and reply immediately. Set BRAINROUTER_INLINE_EXTRACTION=on
      // to restore the old blocking behaviour for debugging.
      cognitiveExtractionTriggered = true;
      const inflightKey = `${userId}${sessionKey}`;
      if (process.env.BRAINROUTER_INLINE_EXTRACTION === "on") {
        const result = await this.extractPendingSensory({ userId, sessionKey, sessionId, activeSkill, skillHints, orgId, projectId, workspaceTag, projectTag });
        cognitiveExtractedCount = result.extractedCount;
        cognitiveExtractionStatus = result.status;
        cognitiveExtractionError = result.errorMessage;
      } else if (!this.extractionInFlight.has(inflightKey)) {
        this.extractionInFlight.add(inflightKey);
        void this.extractPendingSensory({ userId, sessionKey, sessionId, activeSkill, skillHints, orgId, projectId, workspaceTag, projectTag })
          .catch((err: unknown) => console.error("[BrainRouter] background extraction failed:", err instanceof Error ? err.message : err))
          .finally(() => this.extractionInFlight.delete(inflightKey));
        cognitiveExtractionStatus = "deferred";
      } else {
        // An extraction for this session is already running — the in-flight run
        // (and the extraction sweeper) will pick up this window's records too.
        cognitiveExtractionStatus = "deferred";
      }
    }

    return {
      sensoryRecordedCount: sensoryRecords.length,
      cognitiveExtractionTriggered,
      cognitiveExtractedCount,
      cognitiveExtractionStatus,
      cognitiveExtractionError,
    };
  }

  public async processBacklog(params: {
    userId: string;
    sessionKey: string;
    sessionId?: string;
    activeSkill?: string;
    skillHints?: string;
    orgId?: string | null;
    projectId?: string | null;
    workspaceTag?: string | null;
    projectTag?: string | null;
  }): Promise<{ triggered: boolean; extractedCount: number; status: CognitiveExtractionStatus; errorMessage?: string }> {
    return this.extractPendingSensory(params);
  }
}

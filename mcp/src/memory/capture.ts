import type { IMemoryStore } from "@brainrouter/types";
import type { L0Record, CaptureResult, LLMRunner } from "@brainrouter/types";
import { extractL1Memories } from "./pipeline/l1-extractor.js";
import { deduplicateMemories } from "./pipeline/l1-dedup.js";
import { detectContradictions } from "./pipeline/l1-contradiction.js";
import { buildGraphFromL1 } from "./pipeline/graph-builder.js";
import { distillScenes } from "./pipeline/l2-scene.js";
import { distillPersona } from "./pipeline/l3-distiller.js";
import { detectDirectionShift } from "./pipeline/l2-direction-shift.js";
import { shouldRunL2, shouldRunL3 } from "./scheduler.js";
import type { EmbeddingService } from "./store/embedding.js";
import { redactSensitiveMemoryText } from "./redaction.js";
import crypto from "node:crypto";

export class MemoryCapturePipeline {
  constructor(
    private store: IMemoryStore,
    private llmRunner: LLMRunner,
    private embeddingService: EmbeddingService,
    // Triggers L1 extraction every N messages
    private extractEveryNTurns: number = 3
  ) {}

  public async captureTurn(params: {
    userId: string;
    sessionKey: string;
    sessionId?: string;
    messages: { role: string; content: string; timestamp: number }[];
    activeSkill?: string;
    skillHints?: string;
  }): Promise<CaptureResult> {
    const { userId, sessionKey, sessionId = "", messages, activeSkill, skillHints } = params;

    const nowStr = new Date().toISOString();
    const l0Records: L0Record[] = [];

    // 1. Write L0 Records atomically
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const record: L0Record = {
        id: `l0_${sessionKey}_${msg.timestamp}_${i}_${crypto.randomBytes(3).toString("hex")}`,
        userId,
        sessionKey,
        sessionId,
        role: msg.role,
        messageText: redactSensitiveMemoryText(msg.content),
        recordedAt: nowStr,
        timestamp: msg.timestamp,
        skillTag: activeSkill || "",
      };
      
      this.store.upsertL0(record);
      l0Records.push(record);
    }

    // 2. Decide if we should trigger L1 extraction
    const unextractedCount = this.store.getUnextractedL0Count(userId, sessionKey);
    
    let l1ExtractionTriggered = false;
    let l1ExtractedCount = 0;

    // Trigger L1 extraction if the unextracted message count meets or exceeds the threshold
    if (unextractedCount >= this.extractEveryNTurns) {
      const result = await this.extractPendingL0({ userId, sessionKey, sessionId, activeSkill, skillHints });
      l1ExtractionTriggered = result.triggered;
      l1ExtractedCount = result.extractedCount;
    }

    return {
      l0RecordedCount: l0Records.length,
      l1ExtractionTriggered,
      l1ExtractedCount
    };
  }

  public async processBacklog(params: {
    userId: string;
    sessionKey: string;
    sessionId?: string;
    activeSkill?: string;
    skillHints?: string;
  }): Promise<{ triggered: boolean; extractedCount: number }> {
    return this.extractPendingL0(params);
  }

  private async extractPendingL0(params: {
    userId: string;
    sessionKey: string;
    sessionId?: string;
    activeSkill?: string;
    skillHints?: string;
  }): Promise<{ triggered: boolean; extractedCount: number }> {
    const { userId, sessionKey, sessionId = "", activeSkill, skillHints } = params;
    const recentL0 = this.store.getRecentL0Messages(userId, sessionKey, 20);
    if (recentL0.length === 0) {
      return { triggered: false, extractedCount: 0 };
    }

    const extractionResult = await extractL1Memories({
      messages: recentL0,
      userId,
      sessionKey,
      sessionId,
      llmRunner: this.llmRunner,
      activeSkill,
      // Pass existing scene names so the LLM can reuse them instead of coining near-duplicates
      existingSceneNames: this.store.getTopL2Scenes(userId, 20).map(s => s.sceneName),
      // Auto-inject hints from DB if caller didn't supply them manually
      skillHints: skillHints ?? (activeSkill ? this.store.getSkillHints(activeSkill) ?? undefined : undefined)
    });

    if (!extractionResult.success) {
      this.store.recordExtractionFailure(userId, extractionResult.errorMessage ?? "L1 extraction failed");
      return { triggered: true, extractedCount: 0 };
    }

    this.store.markL0Extracted(userId, sessionKey, recentL0.map((record) => record.id));
    this.store.resetExtractionFailures(userId);

    if (extractionResult.records.length === 0) {
      return { triggered: true, extractedCount: 0 };
    }

    // Run active deduplication BEFORE storing
    const { uniqueRecords, droppedCount } = await deduplicateMemories({
      records: extractionResult.records,
      store: this.store,
      userId
    });

    if (droppedCount > 0) {
      console.log(`[BrainRouter] Dropped ${droppedCount} identical duplicate memories.`);
    }

    // Write to store
    for (const record of uniqueRecords) {
      this.store.upsertL1(record);

      // Non-blocking background embedding (Slice A)
      if (this.embeddingService.isReady()) {
        this.embeddingService.embed(record.content)
          .then((vec) => {
            this.store.upsertL1Vec(record.id, vec);
          })
          .catch((err) => {
            console.error(`[BrainRouter] Background embedding failed for ${record.id}:`, err.message);
          });
      }

      // Non-blocking contradiction detection (Slice C)
      detectContradictions({
        newRecord: record,
        store: this.store,
        llmRunner: this.llmRunner
      }).catch(err => {
        console.error(`[BrainRouter] Background contradiction check failed for ${record.id}:`, err.message);
      });

      // Non-blocking graph extraction (GraphRAG Slice)
      buildGraphFromL1({
        record,
        store: this.store,
        llmRunner: this.llmRunner
      }).catch(err => {
        console.error(`[BrainRouter] Background graph extraction failed for ${record.id}:`, err.message);
      });
    }

    const l1ExtractedCount = uniqueRecords.length;
    if (l1ExtractedCount === 0) {
      return { triggered: true, extractedCount: 0 };
    }

    // Update scheduler counters
    this.store.incrementSchedulerL1Count(userId, l1ExtractedCount);

    // Check if L2 scene distillation should fire (non-blocking)
    // Priority 1: Check for a major topic direction shift — fires L2 immediately.
    // Priority 2: Fall back to count-based threshold.
    const topScenes = this.store.getTopL2Scenes(userId, 1);
    if (topScenes.length > 0) {
      detectDirectionShift({
        activeScene: topScenes[0],
        newL1Records: uniqueRecords,
        llmRunner: this.llmRunner,
      }).then(shiftResult => {
        if (shiftResult.shift && shiftResult.confidence >= 0.75) {
          console.error(`[BrainRouter] L2 direction shift detected (confidence=${shiftResult.confidence.toFixed(2)}): ${shiftResult.reason}. Triggering early L2 distillation.`);
          this.store.resetSchedulerL2Count(userId);
          distillScenes({ userId, store: this.store, llmRunner: this.llmRunner })
            .catch(err => console.error("[BrainRouter] Background L2 distillation failed:", err.message));
        } else {
          // No direction shift — fall back to count-based threshold
          const countState = this.store.getSchedulerState(userId);
          if (shouldRunL2(countState)) {
            this.store.resetSchedulerL2Count(userId);
            distillScenes({ userId, store: this.store, llmRunner: this.llmRunner })
              .catch(err => console.error("[BrainRouter] Background L2 distillation failed:", err.message));
          }
        }
      }).catch(err => console.error("[BrainRouter] Background direction shift detection failed:", err.message));
    } else {
      // No existing scenes yet — just use count-based threshold
      const countState = this.store.getSchedulerState(userId);
      if (shouldRunL2(countState)) {
        this.store.resetSchedulerL2Count(userId);
        distillScenes({ userId, store: this.store, llmRunner: this.llmRunner })
          .catch(err => console.error("[BrainRouter] Background L2 distillation failed:", err.message));
      }
    }

    // Check if L3 persona distillation should fire (non-blocking)
    const l3State = this.store.getSchedulerState(userId);
    if (shouldRunL3(l3State)) {
      this.store.resetSchedulerL3Count(userId);
      distillPersona({ userId, store: this.store, llmRunner: this.llmRunner })
        .catch(err => console.error("[BrainRouter] Background L3 distillation failed:", err.message));
    }

    return { triggered: true, extractedCount: l1ExtractedCount };
  }
}

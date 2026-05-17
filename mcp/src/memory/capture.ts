import type { SqliteMemoryStore } from "./store/sqlite.js";
import type { L0Record, CaptureResult, LLMRunner } from "./types.js";
import { extractL1Memories } from "./pipeline/l1-extractor.js";
import { deduplicateMemories } from "./pipeline/l1-dedup.js";
import { detectContradictions } from "./pipeline/l1-contradiction.js";
import { distillScenes } from "./pipeline/l2-scene.js";
import { distillPersona } from "./pipeline/l3-distiller.js";
import { shouldRunL2, shouldRunL3 } from "./scheduler.js";
import type { EmbeddingService } from "./store/embedding.js";
import crypto from "node:crypto";

export class MemoryCapturePipeline {
  constructor(
    private store: SqliteMemoryStore,
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
        messageText: msg.content,
        recordedAt: nowStr,
        timestamp: msg.timestamp,
        skillTag: activeSkill || "",
      };
      
      this.store.upsertL0(record);
      l0Records.push(record);
    }

    // 2. Decide if we should trigger L1 extraction
    const unextractedCount = this.store.getUnextractedL0Count(userId, sessionKey);
    const recentL0 = this.store.getRecentL0Messages(userId, sessionKey, 20);
    
    let l1ExtractionTriggered = false;
    let l1ExtractedCount = 0;

    // Trigger L1 extraction if the unextracted message count meets or exceeds the threshold
    if (unextractedCount >= this.extractEveryNTurns && recentL0.length > 0) {
      l1ExtractionTriggered = true;
      
      const extractionResult = await extractL1Memories({
        messages: recentL0,
        userId,
        sessionKey,
        sessionId,
        llmRunner: this.llmRunner,
        activeSkill,
        // Auto-inject hints from DB if caller didn't supply them manually
        skillHints: skillHints ?? (activeSkill ? this.store.getSkillHints(activeSkill) ?? undefined : undefined)
      });

      if (extractionResult.success && extractionResult.records.length > 0) {
        // Run active deduplication BEFORE storing
        const { uniqueRecords, droppedCount } = await deduplicateMemories({
          records: extractionResult.records,
          store: this.store,
          userId
        });

        l1ExtractedCount = uniqueRecords.length;
        
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
        }

        // Update scheduler counters
        this.store.incrementSchedulerL1Count(userId, l1ExtractedCount);

        // Check if L2 scene distillation should fire (non-blocking)
        const state = this.store.getSchedulerState(userId);
        if (shouldRunL2(state)) {
          this.store.resetSchedulerL2Count(userId);
          distillScenes({ userId, store: this.store, llmRunner: this.llmRunner })
            .catch(err => console.error("[BrainRouter] Background L2 distillation failed:", err.message));
        }

        // Check if L3 persona distillation should fire (non-blocking)
        if (shouldRunL3(state)) {
          this.store.resetSchedulerL3Count(userId);
          distillPersona({ userId, store: this.store, llmRunner: this.llmRunner })
            .catch(err => console.error("[BrainRouter] Background L3 distillation failed:", err.message));
        }
      }
    }

    return {
      l0RecordedCount: l0Records.length,
      l1ExtractionTriggered,
      l1ExtractedCount
    };
  }
}

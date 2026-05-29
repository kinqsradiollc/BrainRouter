import type { IMemoryStore } from "@kinqs/brainrouter-types";
import type { SensoryRecord, CaptureResult, LLMRunner, CognitiveExtractionStatus } from "@kinqs/brainrouter-types";
import { extractCognitiveMemories } from "./pipeline/cognitive-extractor.js";
import { deduplicateMemories } from "./pipeline/cognitive-dedup.js";
import { detectContradictions } from "./pipeline/cognitive-contradiction.js";
import { buildGraphFromCognitive } from "./pipeline/graph-builder.js";
import { distillFocusScenes } from "./pipeline/contextual-focus-builder.js";
import { distillCoreIdentity } from "./pipeline/identity-distiller.js";
import { detectFocusShift } from "./pipeline/focus-direction-shift.js";
import { shouldRunFocusDistill, shouldRunIdentityDistill } from "./scheduler.js";
import { runAsJob } from "./scheduler/runner.js";
import type { EmbeddingService } from "./store/embedding.js";
import { NeuralSparkEngine } from "./pipeline/neural-spark.js";
import { redactSensitiveMemoryText } from "./redaction.js";
import crypto from "node:crypto";

export class MemoryCapturePipeline {
  constructor(
    private store: IMemoryStore,
    private llmRunner: LLMRunner,
    private embeddingService: EmbeddingService,
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
    const sensoryRecords: SensoryRecord[] = [];

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
      };
      
      this.store.upsertSensory(record);
      sensoryRecords.push(record);
    }

    // 2. Decide if we should trigger Cognitive extraction
    const unextractedCount = this.store.getUnextractedSensoryCount(userId, sessionKey);

    let cognitiveExtractionTriggered = false;
    let cognitiveExtractedCount = 0;
    let cognitiveExtractionStatus: CaptureResult["cognitiveExtractionStatus"] = "skipped";
    let cognitiveExtractionError: string | undefined;

    if (unextractedCount >= this.extractEveryNTurns) {
      const result = await this.extractPendingSensory({ userId, sessionKey, sessionId, activeSkill, skillHints });
      cognitiveExtractionTriggered = result.triggered;
      cognitiveExtractedCount = result.extractedCount;
      cognitiveExtractionStatus = result.status;
      cognitiveExtractionError = result.errorMessage;
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
  }): Promise<{ triggered: boolean; extractedCount: number; status: CognitiveExtractionStatus; errorMessage?: string }> {
    return this.extractPendingSensory(params);
  }

  private async extractPendingSensory(params: {
    userId: string;
    sessionKey: string;
    sessionId?: string;
    activeSkill?: string;
    skillHints?: string;
  }): Promise<{ triggered: boolean; extractedCount: number; status: CognitiveExtractionStatus; errorMessage?: string }> {
    const { userId, sessionKey, sessionId = "", activeSkill, skillHints } = params;
    const recentSensory = this.store.getRecentSensoryMessages(userId, sessionKey, 20);
    if (recentSensory.length === 0) {
      return { triggered: false, extractedCount: 0, status: "skipped" };
    }

    const { result: extractionResult } = await runAsJob(
      this.store,
      "cognitive_extractor",
      { userId, sensoryIds: recentSensory.map((r) => r.id) },
      () =>
        extractCognitiveMemories({
          messages: recentSensory,
          userId,
          sessionKey,
          sessionId,
          llmRunner: this.llmRunner,
          activeSkill,
          existingSceneNames: this.store.getTopContextualFocus(userId, 20).map(s => s.sceneName),
          skillHints: skillHints ?? (activeSkill ? this.store.getSkillHints(activeSkill) ?? undefined : undefined)
        }),
      { summarize: (r) => ({ success: r.success, records: r.records?.length ?? 0 }) },
    );

    if (!extractionResult.success) {
      this.store.recordExtractionFailure(userId, extractionResult.errorMessage ?? "Cognitive extraction failed");
      return {
        triggered: true,
        extractedCount: 0,
        status: "failed",
        errorMessage: extractionResult.errorMessage ?? "Cognitive extraction failed",
      };
    }

    this.store.markSensoryExtracted(userId, sessionKey, recentSensory.map((record) => record.id));
    this.store.resetExtractionFailures(userId);

    if (extractionResult.records.length === 0) {
      // LLM returned an empty list — legitimate "nothing notable" outcome
      // (e.g. a greeting or trivial exchange). Status is "ok" so the CLI
      // doesn't surface a misleading "extractor broke" warning.
      return { triggered: true, extractedCount: 0, status: "ok" };
    }

    // Run active deduplication BEFORE storing
    const { result: dedupResult } = await runAsJob(
      this.store,
      "memory_deduper",
      { userId, recordIds: extractionResult.records.map((r) => r.id) },
      () =>
        deduplicateMemories({
          records: extractionResult.records,
          store: this.store,
          userId
        }),
      { summarize: (r) => ({ unique: r.uniqueRecords.length, dropped: r.droppedCount }) },
    );
    const { uniqueRecords, droppedCount } = dedupResult;

    if (droppedCount > 0) {
      console.log(`[BrainRouter] Dropped ${droppedCount} duplicate cognitive memories.`);
    }

    // Write to store
    for (const record of uniqueRecords) {
      this.store.upsertCognitive(record);

      // Non-blocking background embedding (Slice A)
      if (this.embeddingService.isReady()) {
        this.embeddingService.embed(record.content)
          .then((vec) => {
            this.store.upsertCognitiveVec(record.id, vec);
          })
          .catch((err: any) => {
            console.error(`[BrainRouter] Background embedding failed for ${record.id}:`, err.message);
          });
      }

      // Non-blocking contradiction check (Slice C)
      runAsJob(
        this.store,
        "contradiction_checker",
        { userId, recordIds: [record.id] },
        () =>
          detectContradictions({
            newRecord: record,
            store: this.store,
            llmRunner: this.llmRunner
          }),
      ).catch((err: any) => {
        console.error(`[BrainRouter] Background contradiction check failed for ${record.id}:`, err.message);
      });

      // Non-blocking graph extraction (GraphRAG Slice)
      runAsJob(
        this.store,
        "graph_extractor",
        { userId, recordIds: [record.id] },
        () =>
          buildGraphFromCognitive({
            record,
            store: this.store,
            llmRunner: this.llmRunner
          }),
      ).catch((err: any) => {
        console.error(`[BrainRouter] Background graph extraction failed for ${record.id}:`, err.message);
      });
    }

    // --- Seeding Dendritic Spine Connections ---
    for (let i = 0; i < uniqueRecords.length; i++) {
      const recA = uniqueRecords[i];

      // 1. Connect with other records extracted in this same batch/turn
      for (let j = i + 1; j < uniqueRecords.length; j++) {
        const recB = uniqueRecords[j];
        this.store.upsertConnection(userId, recA.id, recB.id, 0.5);
        this.store.upsertConnection(userId, recB.id, recA.id, 0.5);
      }

      // 2. Connect with existing active records sharing the same focus scene name
      if (recA.sceneName) {
        const matchingRecords = this.store.getCognitivesByFocus(userId, recA.sceneName, 10);
        for (const match of matchingRecords) {
          if (match.record_id !== recA.id) {
            this.store.upsertConnection(userId, recA.id, match.record_id, 0.5);
            this.store.upsertConnection(userId, match.record_id, recA.id, 0.5);
          }
        }
      }
    }

    const cognitiveExtractedCount = uniqueRecords.length;
    if (cognitiveExtractedCount === 0) {
      // All extracted records were duplicates of existing memories — the
      // LLM ran fine, dedup just dropped everything. Still "ok".
      return { triggered: true, extractedCount: 0, status: "ok" };
    }

    // Update scheduler counters
    this.store.incrementSchedulerCognitiveCount(userId, cognitiveExtractedCount);

    // Check if Focus distillation should fire
    const topScenes = this.store.getTopContextualFocus(userId, 1);
    if (topScenes.length > 0) {
      runAsJob(
        this.store,
        "focus_shift_judge",
        { userId },
        () =>
          detectFocusShift({
            activeScene: topScenes[0],
            newCognitiveRecords: uniqueRecords,
            llmRunner: this.llmRunner,
          }),
        { summarize: (r) => ({ shift: r.shift, confidence: r.confidence }) },
      ).then(({ result: shiftResult }) => {
        if (shiftResult.shift && shiftResult.confidence >= 0.75) {
          console.error(`[BrainRouter] Focus shift detected (confidence=${shiftResult.confidence.toFixed(2)}): ${shiftResult.reason}. Triggering focus distillation.`);
          this.store.resetSchedulerFocusCount(userId);
          try {
            const sparkEngine = new NeuralSparkEngine(this.store);
            sparkEngine.decayAndPrune(userId);
          } catch (err: any) {
            console.error("[BrainRouter] LTD decay and prune failed:", err.message);
          }
          this.distillFocusAsJob(userId);
        } else {
          const countState = this.store.getSchedulerState(userId);
          if (shouldRunFocusDistill(countState)) {
            this.store.resetSchedulerFocusCount(userId);
            try {
              const sparkEngine = new NeuralSparkEngine(this.store);
              sparkEngine.decayAndPrune(userId);
            } catch (err: any) {
              console.error("[BrainRouter] LTD decay and prune failed:", err.message);
            }
            this.distillFocusAsJob(userId);
          }
        }
      }).catch(err => console.error("[BrainRouter] Background focus shift detection failed:", err.message));
    } else {
      const countState = this.store.getSchedulerState(userId);
      if (shouldRunFocusDistill(countState)) {
        this.store.resetSchedulerFocusCount(userId);
        try {
          const sparkEngine = new NeuralSparkEngine(this.store);
          sparkEngine.decayAndPrune(userId);
        } catch (err: any) {
          console.error("[BrainRouter] LTD decay and prune failed:", err.message);
        }
        this.distillFocusAsJob(userId);
      }
    }

    // Check if Core Identity distillation should fire
    const identityState = this.store.getSchedulerState(userId);
    if (shouldRunIdentityDistill(identityState)) {
      this.store.resetSchedulerIdentityCount(userId);
      this.distillIdentityAsJob(userId);
    }

    return { triggered: true, extractedCount: cognitiveExtractedCount, status: "ok" };
  }

  /**
   * Fire-and-forget focus distillation, recorded as a `focus_distiller`
   * job row. Same behaviour as the previous inline call — errors are
   * logged, never thrown — but now observable via memory_agent_status.
   */
  private distillFocusAsJob(userId: string): void {
    runAsJob(
      this.store,
      "focus_distiller",
      { userId },
      () => distillFocusScenes({ userId, store: this.store, llmRunner: this.llmRunner }),
      { summarize: (r) => ({ sceneNames: r.sceneNames }) },
    ).catch((err: any) =>
      console.error("[BrainRouter] Background focus distillation failed:", err.message),
    );
  }

  /** Fire-and-forget identity distillation, recorded as an `identity_distiller` job row. */
  private distillIdentityAsJob(userId: string): void {
    runAsJob(
      this.store,
      "identity_distiller",
      { userId },
      () => distillCoreIdentity({ userId, store: this.store, llmRunner: this.llmRunner }),
      { summarize: (r) => ({ success: r.success }) },
    ).catch((err: any) =>
      console.error("[BrainRouter] Background core identity distillation failed:", err.message),
    );
  }
}

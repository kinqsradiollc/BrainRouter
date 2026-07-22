import type { CognitiveExtractionStatus, LLMRunner } from "@kinqs/brainrouter-types";
import { extractCognitiveMemories } from "../pipeline/cognitive/cognitive-extractor.js";
import { deduplicateMemories } from "../pipeline/cognitive/cognitive-dedup.js";
import { detectContradictions } from "../pipeline/cognitive/cognitive-contradiction.js";
import { buildGraphFromCognitive } from "../pipeline/graph/graph-builder.js";
import { distillFocusScenes } from "../pipeline/focus/contextual-focus-builder.js";
import { distillCoreIdentity } from "../pipeline/identity/identity-distiller.js";
import { detectFocusShift } from "../pipeline/focus/focus-direction-shift.js";
import { shouldRunFocusDistill, shouldRunIdentityDistill } from "../scheduler.js";
import { runAsJob } from "../scheduler/runner.js";
import { resolveDedupMode, contentHash, isDuplicate, type DedupCandidate } from "../pipeline/cognitive/apply-dedup.js";
import { NeuralSparkEngine } from "../pipeline/skill/neural-spark.js";
import { CapturePersistence } from "./persistence.js";
import { memoryTagsFromSensory } from "./memoryTags.js";

/**
 * Cognitive-extraction concern: pull the pending sensory window, run the
 * extract → dedup → admit → commit chain, seed connections + provenance, and
 * fire the focus/identity distillation jobs. Method bodies are moved
 * byte-identically from the god file; the capture-entry layer extends this.
 */
export class CaptureExtraction extends CapturePersistence {
  protected async extractPendingSensory(params: {
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
    const { userId, sessionKey, sessionId = "", activeSkill, skillHints, orgId, projectId, workspaceTag, projectTag } = params;
    const llmRunner = this.resolveLlmRunner
      ? await this.resolveLlmRunner(orgId, userId)
      : this.llmRunner;
    const recentSensory = await this.store.getRecentSensoryMessages(userId, sessionKey, 20);
    if (recentSensory.length === 0) {
      return { triggered: false, extractedCount: 0, status: "skipped" };
    }

    const existingSceneNames = (await this.store.getTopContextualFocus(userId, 20)).map(s => s.sceneName);
    const memoryTags = memoryTagsFromSensory(recentSensory);
    const resolvedSkillHints = skillHints ?? (activeSkill ? (await this.store.getSkillHints(activeSkill)) ?? undefined : undefined);
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
          llmRunner,
          activeSkill,
          memoryTags,
          existingSceneNames,
          skillHints: resolvedSkillHints,
          orgId,
          workspaceTag,
          projectTag
        }),
      { summarize: (r) => ({ success: r.success, records: r.records?.length ?? 0 }) },
    );

    if (!extractionResult.success) {
      await this.store.recordExtractionFailure(userId, extractionResult.errorMessage ?? "Cognitive extraction failed");
      return {
        triggered: true,
        extractedCount: 0,
        status: "failed",
        errorMessage: extractionResult.errorMessage ?? "Cognitive extraction failed",
      };
    }

    await this.store.markSensoryExtracted(userId, sessionKey, recentSensory.map((record) => record.id));
    await this.store.resetExtractionFailures(userId);

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
    let uniqueRecords = dedupResult.uniqueRecords;
    const droppedCount = dedupResult.droppedCount;

    if (droppedCount > 0) {
      console.log(`[BrainRouter] Dropped ${droppedCount} duplicate cognitive memories.`);
    }

    // AUG-A2 — apply-time dedup guard. Default `off` → no-op (this branch is
    // skipped entirely). `strict`/`fuzzy` drop exact-/near-duplicate records
    // the LLM dedup may have missed, deterministically, before they land.
    const dedupMode = resolveDedupMode();
    if (dedupMode !== "off") {
      const kept: DedupCandidate[] = [];
      const guarded = uniqueRecords.filter((r) => {
        const candidate: DedupCandidate = { hash: contentHash(r.content) };
        if (isDuplicate(dedupMode, candidate, kept)) return false;
        kept.push(candidate);
        return true;
      });
      const applyDropped = uniqueRecords.length - guarded.length;
      if (applyDropped > 0) {
        console.log(`[BrainRouter] apply-dedup (${dedupMode}) dropped ${applyDropped} duplicate record(s).`);
      }
      uniqueRecords = guarded;
    }

    // MEM-16 — blackboard-default admission: stage + reconcile the batch; only
    // the survivors proceed to commit. Reassigning uniqueRecords routes all
    // downstream steps (connections, provenance, focus, count) through the gate.
    const admission = await this.admitViaBlackboard(userId, uniqueRecords);
    uniqueRecords = admission.survivors;

    // Write to store
    for (const record of uniqueRecords) {
      await this.store.upsertCognitive(record);
      await admission.markCommitted(record.id); // MEM-16 — stamp the blackboard item committed

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
            llmRunner
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
            llmRunner
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
        await this.store.upsertConnection(userId, recA.id, recB.id, 0.5);
        await this.store.upsertConnection(userId, recB.id, recA.id, 0.5);
      }

      // 2. Connect with existing active records sharing the same focus scene name
      if (recA.sceneName) {
        const matchingRecords = await this.store.getCognitivesByFocus(userId, recA.sceneName, 10);
        for (const match of matchingRecords) {
          if (match.record_id !== recA.id) {
            await this.store.upsertConnection(userId, recA.id, match.record_id, 0.5);
            await this.store.upsertConnection(userId, match.record_id, recA.id, 0.5);
          }
        }
      }
    }

    // MEM-15 — link each record to the source chunk(s) it actually derives from.
    await this.linkRecordProvenance(userId, recentSensory, uniqueRecords, { orgId, projectId, workspaceTag });

    const cognitiveExtractedCount = uniqueRecords.length;
    if (cognitiveExtractedCount === 0) {
      // All extracted records were duplicates of existing memories — the
      // LLM ran fine, dedup just dropped everything. Still "ok".
      return { triggered: true, extractedCount: 0, status: "ok" };
    }

    // Update scheduler counters
    await this.store.incrementSchedulerCognitiveCount(userId, cognitiveExtractedCount);

    // Check if Focus distillation should fire
    const topScenes = await this.store.getTopContextualFocus(userId, 1);
    if (topScenes.length > 0) {
      runAsJob(
        this.store,
        "focus_shift_judge",
        { userId },
        () =>
          detectFocusShift({
            activeScene: topScenes[0],
            newCognitiveRecords: uniqueRecords,
            llmRunner,
          }),
        { summarize: (r) => ({ shift: r.shift, confidence: r.confidence }) },
      ).then(async ({ result: shiftResult }) => {
        if (shiftResult.shift && shiftResult.confidence >= 0.75) {
          console.error(`[BrainRouter] Focus shift detected (confidence=${shiftResult.confidence.toFixed(2)}): ${shiftResult.reason}. Triggering focus distillation.`);
          await this.store.resetSchedulerFocusCount(userId);
          try {
            const sparkEngine = new NeuralSparkEngine(this.store);
            await sparkEngine.decayAndPrune(userId);
          } catch (err: any) {
            console.error("[BrainRouter] LTD decay and prune failed:", err.message);
          }
          this.distillFocusAsJob(userId, llmRunner);
        } else {
          const countState = await this.store.getSchedulerState(userId);
          if (shouldRunFocusDistill(countState)) {
            await this.store.resetSchedulerFocusCount(userId);
            try {
              const sparkEngine = new NeuralSparkEngine(this.store);
              await sparkEngine.decayAndPrune(userId);
            } catch (err: any) {
              console.error("[BrainRouter] LTD decay and prune failed:", err.message);
            }
            this.distillFocusAsJob(userId, llmRunner);
          }
        }
      }).catch(err => console.error("[BrainRouter] Background focus shift detection failed:", err.message));
    } else {
      const countState = await this.store.getSchedulerState(userId);
      if (shouldRunFocusDistill(countState)) {
        await this.store.resetSchedulerFocusCount(userId);
        try {
          const sparkEngine = new NeuralSparkEngine(this.store);
          await sparkEngine.decayAndPrune(userId);
        } catch (err: any) {
          console.error("[BrainRouter] LTD decay and prune failed:", err.message);
        }
        this.distillFocusAsJob(userId, llmRunner);
      }
    }

    // Check if Core Identity distillation should fire
    const identityState = await this.store.getSchedulerState(userId);
    if (shouldRunIdentityDistill(identityState)) {
      await this.store.resetSchedulerIdentityCount(userId);
      this.distillIdentityAsJob(userId, llmRunner);
    }

    return { triggered: true, extractedCount: cognitiveExtractedCount, status: "ok" };
  }

  /**
   * Fire-and-forget focus distillation, recorded as a `focus_distiller`
   * job row. Same behaviour as the previous inline call — errors are
   * logged, never thrown — but now observable via memory_agent_status.
   */
  protected distillFocusAsJob(userId: string, llmRunner: LLMRunner): void {
    runAsJob(
      this.store,
      "focus_distiller",
      { userId },
      () => distillFocusScenes({ userId, store: this.store, llmRunner }),
      { summarize: (r) => ({ sceneNames: r.sceneNames }) },
    ).catch((err: any) =>
      console.error("[BrainRouter] Background focus distillation failed:", err.message),
    );
  }

  /** Fire-and-forget identity distillation, recorded as an `identity_distiller` job row. */
  protected distillIdentityAsJob(userId: string, llmRunner: LLMRunner): void {
    runAsJob(
      this.store,
      "identity_distiller",
      { userId },
      () => distillCoreIdentity({ userId, store: this.store, llmRunner }),
      { summarize: (r) => ({ success: r.success }) },
    ).catch((err: any) =>
      console.error("[BrainRouter] Background core identity distillation failed:", err.message),
    );
  }
}

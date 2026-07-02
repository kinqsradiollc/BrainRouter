import type { SensoryRecord, CognitiveRecord } from "@kinqs/brainrouter-types";
import { reconcileBlackboard } from "../blackboard/reconcile.js";
import { recordInlineJob } from "../scheduler/runner.js";
import { redactSensitiveMemoryText } from "../util/redaction.js";
import { ingestSource, type SourceIngestStore } from "../source/ingest.js";
import { attributeRecordToChunks, readProvenanceConfig, type AttributableChunk } from "../source/attribution.js";
import { contentHash } from "../pipeline/apply-dedup.js";
import { CaptureBase } from "./base.js";
import { MIN_SOURCE_CHARS, type ProvenanceStore, type BlackboardAdmissionStore } from "./types.js";

/**
 * Capture persistence concern: source-document ingest, chunk-level provenance
 * linking, and blackboard admission. All methods are `protected` and moved
 * byte-identically from the original god file; the extraction + capture-entry
 * layers extend this via the class chain.
 */
export class CapturePersistence extends CaptureBase {
  /**
   * MEM-2′ — narrow the store to the source-ingest capability. These methods
   * live on the concrete SqliteMemoryStore, not the IMemoryStore interface, so
   * detect them at runtime and skip gracefully on a store that lacks them
   * (e.g. a partial test mock) rather than widening the shared contract.
   */
  protected asSourceStore(): SourceIngestStore | null {
    const s = this.store as Partial<SourceIngestStore>;
    return typeof s.createSourceDocument === "function" &&
      typeof s.getSourceChunksByDocument === "function" &&
      typeof s.addSourceChunks === "function"
      ? (s as SourceIngestStore)
      : null;
  }

  /**
   * MEM-2′ — persist substantial turn messages as source documents + chunks.
   * Synchronous but cheap (redact + hash + chunk + local inserts; no LLM or
   * network) and fully best-effort: any failure is logged, never thrown into
   * the turn. Idempotent via createSourceDocument's (user, hash) dedup, so
   * re-capturing identical content reuses the existing doc + chunks.
   */
  protected async ingestTurnSources(
    userId: string,
    sessionKey: string,
    messages: { role: string; content: string; timestamp: number }[],
  ): Promise<void> {
    const sourceStore = this.asSourceStore();
    if (!sourceStore) return;
    for (const msg of messages) {
      const text = redactSensitiveMemoryText(msg.content ?? "");
      if (text.trim().length < MIN_SOURCE_CHARS) continue;
      try {
        const { document, chunks, created } = await ingestSource(
          sourceStore,
          {
            userId,
            // Turn transcripts are workspace-agnostic for now; MEM-14 plumbs scope later.
            workspaceTag: null,
            kind: "transcript",
            uri: null,
            hash: contentHash(text),
            title: `${msg.role} turn @ ${new Date(msg.timestamp).toISOString()}`,
            metadata: { sessionKey, role: msg.role },
          },
          text,
        );
        // MEM-10b — chunking runs inline here (not via the job queue); record an
        // observable source_chunker job when real chunks were written so the
        // agent shows activity instead of "idle · never". Skip idempotent reuse.
        if (created && chunks.length > 0) {
          await recordInlineJob(
            this.store,
            "source_chunker",
            { userId, documentIds: [document.id], source: "capture-ingest" },
            { documentId: document.id, chunkIds: chunks.map((c) => c.id), chunksWritten: chunks.length },
          );
        }
      } catch (err: any) {
        console.error("[BrainRouter] MEM-2′ source ingest failed:", err?.message ?? err);
      }
    }
  }

  /** MEM-3 — runtime-narrow the store to the provenance-linking capability. */
  protected asProvenanceStore(): ProvenanceStore | null {
    const s = this.store as Partial<ProvenanceStore>;
    return typeof s.getSourceDocumentByHash === "function" &&
      typeof s.getSourceChunksByDocument === "function" &&
      typeof s.linkRecordSources === "function"
      ? (s as ProvenanceStore)
      : null;
  }

  /**
   * MEM-15 — exact chunk-level provenance. Gather the candidate source chunks
   * for this extraction window (the chunks of the window messages' source docs,
   * matched by the same redacted-content hash MEM-2′ ingests under), then link
   * EACH record only to the chunk(s) it actually derives from — attributed by
   * salient-token overlap (`attributeRecordToChunks`). Replaces 0.4.3's
   * batch-level "link every record to every chunk" linking, which over-attributed
   * evidence. Deterministic, zero-LLM-cost; best-effort + non-fatal.
   */
  protected async linkRecordProvenance(
    userId: string,
    windowSensory: SensoryRecord[],
    records: { id: string; content: string }[],
  ): Promise<void> {
    const store = this.asProvenanceStore();
    if (!store || records.length === 0) return;
    try {
      // Candidate chunks {id, content} from the window's source docs (deduped).
      const chunks: AttributableChunk[] = [];
      const seen = new Set<string>();
      for (const s of windowSensory) {
        const text = s.messageText ?? "";
        if (text.trim().length < MIN_SOURCE_CHARS) continue;
        const doc = await store.getSourceDocumentByHash(userId, contentHash(text));
        if (!doc) continue;
        for (const c of await store.getSourceChunksByDocument(doc.id)) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          chunks.push({ id: c.id, content: c.content });
        }
      }
      if (chunks.length === 0) return;
      const config = readProvenanceConfig();
      for (const r of records) {
        const chunkIds = attributeRecordToChunks(r.content, chunks, config);
        if (chunkIds.length > 0) await store.linkRecordSources(userId, r.id, chunkIds);
      }
    } catch (err: any) {
      console.error("[BrainRouter] MEM-15 provenance link failed:", err?.message ?? err);
    }
  }

  /** MEM-16 — blackboard admission is the default path; `off` restores the
   * legacy direct-write behaviour. (Brain-side env knob, like the recall ones.) */
  protected blackboardAdmissionEnabled(): boolean {
    return (process.env.BRAINROUTER_BLACKBOARD_ADMISSION ?? "").trim().toLowerCase() !== "off";
  }

  /** MEM-16 — runtime-narrow the store to the blackboard-admission capability. */
  protected asBlackboardStore(): BlackboardAdmissionStore | null {
    const s = this.store as Partial<BlackboardAdmissionStore>;
    return typeof s.stageBlackboardItems === "function" && typeof s.updateBlackboardItem === "function"
      ? (s as BlackboardAdmissionStore)
      : null;
  }

  /**
   * MEM-16 — blackboard-default admission. Instead of writing every extracted
   * record straight to long-term memory, stage them as blackboard candidates,
   * reconcile (dedup the batch + reject below-threshold), and let only the
   * survivors proceed to the normal commit path (upsert + embed + contradiction
   * + graph). Duplicate/rejected candidates stay on the blackboard for audit via
   * `memory_blackboard_review`. The returned `markCommitted` stamps each
   * survivor's blackboard item with the cognitive record it produced.
   *
   * Fail-open: a store without the capability, the knob set to `off`, or any
   * error falls back to admitting all records — capture never loses memory to a
   * blackboard problem. (Cross-active dedup already ran in `deduplicateMemories`;
   * per-record contradiction-vs-active still runs post-commit.)
   */
  protected async admitViaBlackboard(
    userId: string,
    records: CognitiveRecord[],
  ): Promise<{ survivors: CognitiveRecord[]; markCommitted: (recordId: string) => Promise<void> }> {
    const passthrough = { survivors: records, markCommitted: async () => {} };
    if (!this.blackboardAdmissionEnabled() || records.length === 0) return passthrough;
    const store = this.asBlackboardStore();
    if (!store) return passthrough;
    try {
      const staged = await store.stageBlackboardItems(
        userId,
        records.map((r) => ({
          sourceChunkId: null, // precise provenance is linked post-commit (MEM-15)
          score: r.confidence,
          candidate: {
            content: r.content,
            type: r.type,
            priority: r.priority,
            sceneName: r.sceneName,
            confidence: r.confidence,
          },
        })),
      );
      // staged[i] corresponds to records[i] (stageBlackboardItems preserves order).
      const decisions = reconcileBlackboard(staged);
      const decisionById = new Map(decisions.map((d) => [d.id, d]));
      const itemIdByRecordId = new Map<string, string>();
      const survivors: CognitiveRecord[] = [];
      for (let i = 0; i < records.length; i++) {
        const item = staged[i];
        const decision = item ? decisionById.get(item.id) : undefined;
        if (!item || !decision) { survivors.push(records[i]); continue; } // safety: keep
        await store.updateBlackboardItem(item.id, { status: decision.status, conflictIds: decision.conflictIds });
        if (decision.status === "reconciled") {
          itemIdByRecordId.set(records[i].id, item.id);
          survivors.push(records[i]);
        }
        // duplicate / rejected → held on the blackboard, not committed.
      }
      // MEM-10b — admission (stage → reconcile → admit) runs inline here, not via
      // the blackboard_reconciler job queue; record an observable job so the
      // agent reflects the reconciliation it actually performed each capture.
      await recordInlineJob(
        this.store,
        "blackboard_reconciler",
        { userId, source: "capture-admission" },
        {
          staged: staged.length,
          reconciled: decisions.filter((d) => d.status === "reconciled").length,
          duplicate: decisions.filter((d) => d.status === "duplicate").length,
          rejected: decisions.filter((d) => d.status === "rejected").length,
          survivors: survivors.length,
        },
      );
      return {
        survivors,
        markCommitted: async (recordId: string) => {
          const itemId = itemIdByRecordId.get(recordId);
          if (itemId) await store.updateBlackboardItem(itemId, { status: "committed", committedRecordId: recordId });
        },
      };
    } catch (err: any) {
      console.error("[BrainRouter] MEM-16 blackboard admission failed:", err?.message ?? err);
      return passthrough; // fail-open
    }
  }
}

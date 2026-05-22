import type { IMemoryStore } from "@kinqs/brainrouter-types";
import type { RecallResult, CognitiveFtsResult, RecalledMemory, VectorSearchResult, CognitiveRecord, RecallExplanation } from "@kinqs/brainrouter-types";
import type { EmbeddingService } from "./store/embedding.js";
import type { RerankerService } from "./store/reranker.js";
import { expandRecallWithGraph } from "./pipeline/graph-recall.js";
import { detectPrewarmSkills, buildPrewarmBlock } from "./pipeline/skill-prewarm.js";
import { detectTaskIntent, extractFilePathHints, getMemoryTypeConfig } from "./memory-type-config.js";
import { randomUUID } from "node:crypto";
import { NeuralSparkEngine } from "./pipeline/neural-spark.js";

function effectivePriority(memory: CognitiveFtsResult & { citation_count?: number }): number {
  const halfLife = getMemoryTypeConfig(memory.type).halfLifeDays;
  const ageMs = Date.now() - new Date(memory.created_time).getTime();
  const ageDays = ageMs / 86_400_000;

  let base = memory.priority;
  if (halfLife) {
    const decayFactor = Math.pow(0.5, ageDays / halfLife);
    base = memory.priority * decayFactor;
  }

  const citationBoost = Math.min((memory.citation_count ?? 0) * 0.05, 0.30);
  // Freshness boost: anything captured in the last 24h gets a small lift so
  // brand-new facts surface even before they've been cited. Linear ramp from
  // 1.15× at age 0 to 1.0× at age 1d.
  const freshness = ageDays <= 1 ? 1 + 0.15 * (1 - ageDays) : 1;
  return base * (1 + citationBoost) * freshness;
}

/**
 * Optional filters applied to the candidate pool after RRF but before
 * neural-spark propagation and reranking. Filters never *add* records — they
 * narrow what the ranking stage considers, so callers can scope a recall to
 * "feedback memories captured in the last week" without re-implementing the
 * pipeline.
 */
export interface RecallFilters {
  /** Restrict to these memory types (e.g. ["instruction", "feedback"]). */
  types?: string[];
  /** Restrict to records tagged with any of these scene names. */
  scenes?: string[];
  /** ISO timestamp lower bound on created_time. */
  capturedAfter?: string;
  /** ISO timestamp upper bound on created_time. */
  capturedBefore?: string;
  /** Drop records whose stored priority is below this threshold. */
  minPriority?: number;
  /** Restrict to records produced under this skill_tag. */
  skillTag?: string;
}

function applyFilters<T extends CognitiveFtsResult | VectorSearchResult>(
  records: T[],
  filters?: RecallFilters,
): T[] {
  if (!filters) return records;
  const afterMs = filters.capturedAfter ? new Date(filters.capturedAfter).getTime() : undefined;
  const beforeMs = filters.capturedBefore ? new Date(filters.capturedBefore).getTime() : undefined;
  const types = filters.types && filters.types.length > 0 ? new Set(filters.types) : undefined;
  const scenes = filters.scenes && filters.scenes.length > 0 ? new Set(filters.scenes) : undefined;
  return records.filter((r) => {
    if (types && !types.has(r.type)) return false;
    if (scenes && (!r.scene_name || !scenes.has(r.scene_name))) return false;
    if (filters.skillTag && r.skill_tag !== filters.skillTag) return false;
    if (filters.minPriority !== undefined && r.priority < filters.minPriority) return false;
    if (afterMs !== undefined || beforeMs !== undefined) {
      const created = r.created_time ? new Date(r.created_time).getTime() : NaN;
      if (Number.isNaN(created)) return false;
      if (afterMs !== undefined && created < afterMs) return false;
      if (beforeMs !== undefined && created > beforeMs) return false;
    }
    return true;
  });
}

export class MemoryRecallPipeline {
  constructor(
    private store: IMemoryStore,
    private embeddingService: EmbeddingService,
    private rerankerService: RerankerService
  ) { }

  public async recall(params: {
    userId: string;
    sessionKey: string;
    query: string;
    activeSkill?: string;
    explain?: boolean;
    filters?: RecallFilters;
  }): Promise<RecallResult> {
    const startTime = Date.now();
    const { userId, sessionKey, query, activeSkill, filters } = params;
    const intent = detectTaskIntent(query);

    // 1. FTS5 BM25 search (Top 15)
    const ftsResultsRaw = this.store.searchCognitiveFts(userId, query, 15);
    const filePathResultsRaw = this.expandWithFilePathMatches(userId, query);

    // 2. Vector search (Top 15, if enabled)
    let vecResultsRaw: VectorSearchResult[] = [];
    if (this.embeddingService.isReady()) {
      try {
        const queryVec = await this.embeddingService.embed(query);
        vecResultsRaw = this.store.searchCognitiveVec(userId, queryVec, 15);
      } catch (e) {
        console.error("[BrainRouter] Vector search skipped during recall:", (e as Error).message);
      }
    }

    // Filter the three candidate streams BEFORE RRF so the rank is computed
    // on the actually-relevant pool, not a filtered subset of an unfiltered
    // rank (which would bias scores toward records that happen to be in the
    // top-15 globally even if irrelevant to the filter).
    const ftsResults = applyFilters(ftsResultsRaw, filters);
    const vecResults = applyFilters(vecResultsRaw, filters);
    const filePathResults = applyFilters(filePathResultsRaw, filters);

    if (ftsResults.length === 0 && vecResults.length === 0 && filePathResults.length === 0) {
      const emptyStrategy = this.embeddingService.isReady() ? "hybrid-empty" : "keyword-empty";
      const durationMs = Date.now() - startTime;
      const recallExplanation: RecallExplanation = {
        ftsHits: 0,
        vecHits: 0,
        filePathHits: 0,
        rrfTopScore: 0,
        intentDetected: intent,
        typeBoosts: {},
        skillBoostApplied: false,
        rerankerUsed: false,
        graphExpansion: false,
        citationBoosts: {},
        durationMs,
        rerankerCandidates: 0,
        scoredRecords: [],
      };

      if (!params.explain) {
        this.writeRecallOp(userId, sessionKey, query, emptyStrategy, 0, durationMs, recallExplanation);
      }

      return { recallStrategy: emptyStrategy, recallExplanation };
    }

    // 3. RRF Merge (Reciprocal Rank Fusion)
    const rrfMap = new Map<string, { record: CognitiveFtsResult | VectorSearchResult, rrfScore: number }>();

    ftsResults.forEach((r, idx) => {
      const rank = idx + 1;
      rrfMap.set(r.record_id, { record: r, rrfScore: 1 / (60 + rank) });
    });

    vecResults.forEach((r, idx) => {
      const rank = idx + 1;
      const existing = rrfMap.get(r.record_id);
      if (existing) {
        existing.rrfScore += 1 / (60 + rank);
      } else {
        rrfMap.set(r.record_id, { record: r, rrfScore: 1 / (60 + rank) });
      }
    });

    filePathResults.forEach((r, idx) => {
      const existing = rrfMap.get(r.record_id);
      const filePathScore = 1 / (45 + idx + 1);
      if (existing) {
        existing.rrfScore += filePathScore;
      } else {
        rrfMap.set(r.record_id, { record: r, rrfScore: filePathScore });
      }
    });

    const rrfValues = Array.from(rrfMap.values()).map(v => v.rrfScore);
    const rrfTopScore = rrfValues.length > 0 ? Math.max(...rrfValues) : 0;

    // 4. Combine RRF with Decay + Skill boost
    const typeBoosts: Record<string, number> = {};
    const citationBoosts: Record<string, number> = {};
    let skillBoostApplied = false;

    const scoredResults = Array.from(rrfMap.values()).map(({ record, rrfScore }) => {
      const baseScore = rrfScore * 30;
      const priorityScore = (effectivePriority(record as CognitiveFtsResult) / 100);
      let finalScore = (baseScore * 0.7) + (priorityScore * 0.3);

      if (activeSkill && record.skill_tag === activeSkill) {
        finalScore *= 1.2;
        skillBoostApplied = true;
      }

      const intentMultiplier = getMemoryTypeConfig(record.type).intentAffinity[intent] ?? 1;
      if (intentMultiplier !== 1) {
        typeBoosts[record.type] = intentMultiplier;
      }
      finalScore *= intentMultiplier;

      const citationCount = (record as CognitiveFtsResult).citation_count ?? 0;
      const citBoost = Math.min(citationCount * 0.05, 0.30);
      if (citBoost > 0) {
        citationBoosts[record.record_id] = citBoost;
      }

      return { record, score: finalScore };
    });

    // --- Neural Sparks & Spreading Activation ---
    const maxScore = scoredResults.length > 0 ? Math.max(...scoredResults.map(r => r.score)) : 1.0;
    const initialNodes = scoredResults.map(r => ({
      id: r.record.record_id,
      potential: maxScore > 0 ? r.score / maxScore : 0.0,
      fired: false
    }));

    const sparkEngine = new NeuralSparkEngine(this.store);
    const propagatedNodes = sparkEngine.propagateSparks(userId, initialNodes);

    const propagatedMap = new Map(propagatedNodes.map(n => [n.id, n]));
    const existingIds = new Set(scoredResults.map(r => r.record.record_id));
    // Carry the full {id, potential, fired, type, preview, sceneName} so the
    // UI can render a human-friendly label instead of the opaque record id.
    // Track seen ids so we don't double-list a node that appears as both a
    // seed and a propagation target.
    const sparkedNodes: Array<{ id: string; potential: number; fired: boolean; type?: string; preview?: string; sceneName?: string }> = [];
    const sparkedSeen = new Set<string>();
    const previewFromContent = (content: unknown): string | undefined => {
      const text = (content ?? "").toString().trim();
      if (!text) return undefined;
      const oneLine = text.replace(/\s+/g, " ");
      // Keep the preview short — the UI renders a compact pill, anything
      // longer than ~70 chars wraps awkwardly even with ellipsis fallback.
      return oneLine.length > 70 ? `${oneLine.slice(0, 67)}…` : oneLine;
    };
    const pushNode = (
      node: { id: string; potential: number; fired: boolean },
      meta?: { type?: string; preview?: string; sceneName?: string },
    ) => {
      if (!node.id || sparkedSeen.has(node.id)) return;
      sparkedSeen.add(node.id);
      sparkedNodes.push({
        id: node.id,
        potential: Math.max(0, Math.min(1, Number(node.potential) || 0)),
        fired: Boolean(node.fired),
        type: meta?.type,
        preview: meta?.preview,
        sceneName: meta?.sceneName,
      });
    };

    const sparkScoredResults: Array<{ record: any; score: number; fired?: boolean }> = [];

    for (const scored of scoredResults) {
      const propNode = propagatedMap.get(scored.record.record_id);
      if (propNode) {
        const newScore = Math.max(scored.score, propNode.potential * maxScore);
        // Every initial-seed node belongs in the trace, fired or not — the
        // sub-threshold pills carry useful "we considered this but it didn't
        // spread" signal.
        pushNode(propNode, {
          type: scored.record.type,
          preview: previewFromContent(scored.record.content),
          sceneName: scored.record.scene_name,
        });
        sparkScoredResults.push({
          record: scored.record,
          score: propNode.fired ? newScore * 1.5 : newScore,
          fired: propNode.fired
        });
      } else {
        sparkScoredResults.push(scored);
      }
    }

    // Pull in connected memories that were excited above the firing threshold
    for (const propNode of propagatedNodes) {
      if (propNode.fired && !existingIds.has(propNode.id)) {
        const record = this.store.getMemoryById(userId, propNode.id);
        if (record) {
          pushNode(propNode, {
            type: record.type,
            preview: previewFromContent(record.content),
            sceneName: record.sceneName,
          });
          const formattedRecord = {
            record_id: record.id,
            user_id: record.userId,
            content: record.content,
            type: record.type,
            priority: record.priority,
            scene_name: record.sceneName,
            skill_tag: record.skillTag,
            session_key: record.sessionKey,
            timestamp_str: record.timestampStr,
            created_time: record.createdTime,
            citation_count: record.citationCount
          };
          const baseScore = propNode.potential * maxScore;
          sparkScoredResults.push({
            record: formattedRecord,
            score: baseScore * 1.5,
            fired: true
          });
        }
      }
    }

    sparkScoredResults.sort((a, b) => b.score - a.score);
    let topResults = sparkScoredResults.slice(0, 5);
    
    // Stage 3 — Reranker (Top 20 from RRF + Sparks)
    const rerankCandidates = sparkScoredResults.slice(0, 20);
    let usedReranker = false;
    
    if (this.rerankerService.isReady()) {
      try {
        const documents = rerankCandidates.map(r => r.record.content);
        const ranked = await this.rerankerService.rerank({ 
          query, 
          documents, 
          topN: this.rerankerService.getTopN() 
        });
        
        topResults = ranked.map(r => rerankCandidates[r.index]);
        usedReranker = true;
      } catch (e) {
        console.error("[BrainRouter] Reranker failed during recall, falling back to RRF:", (e as Error).message);
      }
    }

    // 5. Format for context
    const memoryLines = topResults.map(({ record }) => {
      const tag = record.scene_name ? `${record.type}|${record.scene_name}` : record.type;
      let line = `- [${tag}] ${record.content}`;
      if (record.skill_tag) {
        line += ` (skill: ${record.skill_tag})`;
      }
      return line;
    });

    const prependContext = `<relevant-memories>\n  The following memories are relevant to this query. Reference only if helpful:\n\n  ${memoryLines.join("\n  ")}\n</relevant-memories>`;

    // Build appendSystemContext with Contextual Focus Navigation + tools guide
    const topScenes = this.store.getTopContextualFocus(userId, 3);
    let appendSystemContext = "";

    if (topScenes.length > 0) {
      const sceneNav = topScenes
        .map(s => `  - ${s.sceneName} (heat: ${s.heatScore.toFixed(0)})`)
        .join("\n");
      appendSystemContext += `<scene-navigation>\n  Recent focus scenes:\n${sceneNav}\n</scene-navigation>\n\n`;
    }

    appendSystemContext += `<memory-tools-guide>
  Use memory_search to retrieve more specific memories.
  Use memory_contradictions to review unresolved conflicts.
  Max 3 memory tool calls per turn.
</memory-tools-guide>`;

    // Graph context expansion (2-hop BFS from matched entities)
    const graphContext = expandRecallWithGraph({
      topCognitiveResults: topResults.map(r => r.record),
      query,
      userId,
      activeSkill,
      store: this.store
    });
    const hasGraphExpansion = !!graphContext;
    if (graphContext) {
      appendSystemContext += `\n${graphContext}`;
    }

    if (process.env.BRAINROUTER_PREWARM_ENABLED === "true") {
      try {
        const prewarmResults = detectPrewarmSkills({
          userId,
          store: this.store,
          excludeSkill: activeSkill,
        });
        const prewarmBlock = buildPrewarmBlock(prewarmResults);
        if (prewarmBlock) {
          appendSystemContext += `\n${prewarmBlock}`;
        }
      } catch (e) {
        console.error("[BrainRouter] Skill pre-warming skipped:", (e as Error).message);
      }
    }

    const recalledCognitiveMemories: RecalledMemory[] = topResults.map(r => ({
      content: r.record.content,
      score: r.score,
      type: r.record.type,
      recordId: r.record.record_id,
      skillTag: r.record.skill_tag
    }));

    const recallStrategy = vecResults.length > 0
      ? (usedReranker ? "hybrid+rerank" : "hybrid")
      : (usedReranker ? "keyword+rerank" : (filePathResults.length > 0 ? "keyword+file" : "keyword"));

    const durationMs = Date.now() - startTime;

    const recallExplanation: RecallExplanation = {
      ftsHits: ftsResults.length,
      vecHits: vecResults.length,
      filePathHits: filePathResults.length,
      rrfTopScore,
      intentDetected: intent,
      typeBoosts,
      skillBoostApplied,
      rerankerUsed: usedReranker,
      graphExpansion: hasGraphExpansion,
      citationBoosts,
      durationMs,
      rerankerCandidates: rerankCandidates.length,
      scoredRecords: topResults.map(r => ({
        recordId: r.record.record_id,
        finalScore: r.score,
        type: r.record.type,
      })),
      sparkedNodes,
    };

    if (!params.explain) {
      this.writeRecallOp(userId, sessionKey, query, recallStrategy, topResults.length, durationMs, recallExplanation);
    }

    return {
      prependContext,
      appendSystemContext,
      recalledCognitiveMemories,
      recallStrategy,
      activeFocusName: topScenes[0]?.sceneName,
      recallExplanation,
    };
  }

  public async explainRecall(params: {
    userId: string;
    sessionKey: string;
    query: string;
    activeSkill?: string;
  }): Promise<RecallResult> {
    return this.recall({ ...params, explain: true });
  }

  private writeRecallOp(
    userId: string,
    sessionKey: string,
    query: string,
    strategy: string,
    hitCount: number,
    durationMs: number,
    explanation?: RecallExplanation
  ) {
    try {
      this.store.insertOperation({
        id: randomUUID(),
        userId,
        recordId: null,
        operation: "recall",
        actor: "agent",
        sessionKey,
        reason: "",
        createdAt: new Date().toISOString(),
        metadata: {
          query: query.slice(0, 500),
          strategy,
          hitCount,
          durationMs,
          ftsHits: explanation?.ftsHits ?? 0,
          vecHits: explanation?.vecHits ?? 0,
          intentDetected: explanation?.intentDetected ?? "none",
          rerankerUsed: explanation?.rerankerUsed ?? false,
        },
      });
    } catch {
      // Audit writes are best-effort
    }
  }

  private expandWithFilePathMatches(userId: string, query: string): CognitiveFtsResult[] {
    const filePaths = extractFilePathHints(query);
    if (filePaths.length === 0) return [];

    const records = new Map<string, CognitiveRecord>();
    for (const filePath of filePaths) {
      for (const record of this.store.getMemoriesByFilePath(userId, filePath, 10)) {
        records.set(record.id, record);
      }
    }

    return Array.from(records.values()).map((record) => ({
      record_id: record.id,
      user_id: record.userId,
      content: record.content,
      type: record.type,
      priority: record.priority,
      scene_name: record.sceneName,
      skill_tag: record.skillTag,
      score: 1,
      timestamp_str: record.timestampStr,
      timestamp_start: record.timestampStart,
      timestamp_end: record.timestampEnd,
      session_key: record.sessionKey,
      session_id: record.sessionId,
      metadata_json: JSON.stringify(record.metadata),
      created_time: record.createdTime,
      citation_count: record.citationCount,
    }));
  }
}

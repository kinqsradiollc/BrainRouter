import type { IMemoryStore } from "@brainrouter/types";
import type { RecallResult, L1FtsResult, RecalledMemory, VectorSearchResult, L1Record } from "@brainrouter/types";
import type { EmbeddingService } from "./store/embedding.js";
import type { RerankerService } from "./store/reranker.js";
import { expandRecallWithGraph } from "./pipeline/graph-recall.js";
import { detectPrewarmSkills, buildPrewarmBlock } from "./pipeline/skill-prewarm.js";
import { detectTaskIntent, extractFilePathHints, getMemoryTypeConfig } from "./memory-type-config.js";

function effectivePriority(memory: L1FtsResult & { citation_count?: number }): number {
  const halfLife = getMemoryTypeConfig(memory.type).halfLifeDays;

  if (!halfLife) {
    return memory.priority; // e.g. instruction
  }

  const ageMs = Date.now() - new Date(memory.created_time).getTime();
  const ageDays = ageMs / 86_400_000;
  const decayFactor = Math.pow(0.5, ageDays / halfLife);
  const decayedPriority = memory.priority * decayFactor;

  // ACE citation boost: each citation adds +5% effective priority, capped at +30%
  const citationBoost = Math.min((memory.citation_count ?? 0) * 0.05, 0.30);
  return decayedPriority * (1 + citationBoost);
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
  }): Promise<RecallResult> {
    const { userId, sessionKey, query, activeSkill } = params;
    const intent = detectTaskIntent(query);

    // 1. FTS5 BM25 search (Top 15)
    const ftsResults = this.store.searchL1Fts(userId, query, 15);
    const filePathResults = this.expandWithFilePathMatches(userId, query);

    // 2. Vector search (Top 15, if enabled)
    let vecResults: VectorSearchResult[] = [];
    if (this.embeddingService.isReady()) {
      try {
        const queryVec = await this.embeddingService.embed(query);
        vecResults = this.store.searchL1Vec(userId, queryVec, 15);
      } catch (e) {
        console.error("[BrainRouter] Vector search skipped during recall:", (e as Error).message);
      }
    }

    if (ftsResults.length === 0 && vecResults.length === 0 && filePathResults.length === 0) {
      return { recallStrategy: this.embeddingService.isReady() ? "hybrid-empty" : "keyword-empty" };
    }

    // 3. RRF Merge (Reciprocal Rank Fusion)
    // Formula: score = Σ 1 / (60 + rank)
    const rrfMap = new Map<string, { record: L1FtsResult | VectorSearchResult, rrfScore: number }>();

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

    // 4. Combine RRF with Decay + Skill boost
    const scoredResults = Array.from(rrfMap.values()).map(({ record, rrfScore }) => {
      // Scale RRF score (which is typically small, e.g. 1/60 + 1/60 ≈ 0.033) to 0-1ish range
      // For top 1/1, max possible is 2/61 ≈ 0.0327. Let's multiply by 30 to get ~1.0
      const baseScore = rrfScore * 30;

      // Decay priority (0-100) contributes to the final blend
      const priorityScore = (effectivePriority(record as L1FtsResult) / 100);

      // Blend: 70% relevance (RRF), 30% priority/freshness
      let finalScore = (baseScore * 0.7) + (priorityScore * 0.3);

      if (activeSkill && record.skill_tag === activeSkill) {
        finalScore *= 1.2;
      }

      finalScore *= getMemoryTypeConfig(record.type).intentAffinity[intent] ?? 1;

      return { record, score: finalScore };
    });

    // Sort by final score descending
    scoredResults.sort((a, b) => b.score - a.score);
    
    let topResults = scoredResults.slice(0, 5);
    
    // Stage 3 — Reranker (Top 20 from RRF)
    const rerankCandidates = scoredResults.slice(0, 20);
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

    // Build appendSystemContext with L2 Scene Navigation + tools guide
    const topScenes = this.store.getTopL2Scenes(userId, 3);

    let appendSystemContext = "";

    if (topScenes.length > 0) {
      const sceneNav = topScenes
        .map(s => `  - ${s.sceneName} (heat: ${s.heatScore.toFixed(0)})`)
        .join("\n");
      appendSystemContext += `<scene-navigation>\n  Recent scenes:\n${sceneNav}\n</scene-navigation>\n\n`;
    }

    appendSystemContext += `<memory-tools-guide>
  Use memory_search to retrieve more specific memories.
  Use memory_contradictions to review unresolved conflicts.
  Max 3 memory tool calls per turn.
</memory-tools-guide>`;

    // Graph context expansion (2-hop BFS from matched entities)
    const graphContext = expandRecallWithGraph({
      topL1Results: topResults.map(r => r.record),
      query,
      userId,
      activeSkill,
      store: this.store
    });
    if (graphContext) {
      appendSystemContext += `\n${graphContext}`;
    }

    // Skill pre-warming injection (opt-in via BRAINROUTER_PREWARM_ENABLED)
    if (process.env.BRAINROUTER_PREWARM_ENABLED === "true") {
      try {
        const prewarmResults = detectPrewarmSkills({
          userId,
          store: this.store,
          excludeSkill: activeSkill, // don't duplicate hints already provided by active skill
        });
        const prewarmBlock = buildPrewarmBlock(prewarmResults);
        if (prewarmBlock) {
          appendSystemContext += `\n${prewarmBlock}`;
        }
      } catch (e) {
        // Pre-warming is best-effort — never block recall on failure
        console.error("[BrainRouter] Skill pre-warming skipped:", (e as Error).message);
      }
    }

    const recalledL1Memories: RecalledMemory[] = topResults.map(r => ({
      content: r.record.content,
      score: r.score,
      type: r.record.type,
      recordId: r.record.record_id,
      skillTag: r.record.skill_tag
    }));

    return {
      prependContext,
      appendSystemContext,
      recalledL1Memories,
      recallStrategy: vecResults.length > 0 
        ? (usedReranker ? "hybrid+rerank" : "hybrid") 
        : (usedReranker ? "keyword+rerank" : (filePathResults.length > 0 ? "keyword+file" : "keyword")),
      activeScene: topScenes[0]?.sceneName,
    };
  }

  private expandWithFilePathMatches(userId: string, query: string): L1FtsResult[] {
    const filePaths = extractFilePathHints(query);
    if (filePaths.length === 0) return [];

    const records = new Map<string, L1Record>();
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

import type { IMemoryStore } from "@kinqs/brainrouter-types";
import type { RecallResult, CognitiveFtsResult, RecalledMemory, VectorSearchResult, CognitiveRecord, RecallExplanation } from "@kinqs/brainrouter-types";
import { projectTagFromName } from "@kinqs/brainrouter-types";
import type { EmbeddingService } from "../store/embedding.js";
import type { RerankerService } from "../store/reranker.js";
import { rerankerMaxDocChars } from "../store/reranker.js";
import { expandRecallWithGraph } from "../pipeline/graph/graph-recall.js";
import { detectPrewarmSkills, buildPrewarmBlock } from "../pipeline/skill/skill-prewarm.js";
import { detectTaskIntent, extractFilePathHints, getMemoryTypeConfig } from "../config/memory-type-config.js";
import { randomUUID } from "node:crypto";
import { NeuralSparkEngine } from "../pipeline/skill/neural-spark.js";
import { gatherRecordRefs, formatRefHint, type RecordRefsStore } from "../util/recall-refs.js";
import {
  applyRecallCompression,
  readRecallCompressionConfig,
  RECALL_COMPRESSION_NOTE,
} from "../compression/recallCompression.js";
import {
  effectivePriorityScore,
  churnAdjustedHalfLife,
  baseScoreFromRrf,
  normalizePriority,
  capPriority,
  blendBaseAndPriority,
  intentBoost,
  citationBoost,
  SKILL_BOOST,
  tokenSet,
  lexicalOverlap,
  selectMMR,
  LEXICAL_SCORE_FLOOR,
  type MmrCandidate,
} from "../reranker/index.js";
import {
  readRecallLimits,
  readRecallSelection,
  readRerankBlendAlpha,
  blendByRank,
  readRerankCharBudget,
  rerankHeadSize,
  isReflectiveQuery,
  readQueryRoutingEnabled,
  type RecallLimits,
  type RecallSelection,
} from "./config.js";
import { applyFilters, type RecallFilters } from "./filters.js";

function effectivePriority(memory: CognitiveFtsResult & { citation_count?: number }, churnCommitCount90d?: number): number {
  // B7 (MEM-CHURN) — shorten the half-life for memories anchored to high-churn
  // files. `churn` undefined / 0 → the base half-life, so existing data and every
  // non-code memory are scored exactly as before.
  const halfLife = churnAdjustedHalfLife(getMemoryTypeConfig(memory.type).halfLifeDays, churnCommitCount90d);
  const ageDays = (Date.now() - new Date(memory.created_time).getTime()) / 86_400_000;
  // AUG-A3 — score-composition math lives in the modular `reranker/` package.
  return effectivePriorityScore({
    priority: memory.priority,
    ageDays,
    halfLifeDays: halfLife,
    citationCount: memory.citation_count,
  });
}

export class MemoryRecallPipeline {
  constructor(
    private store: IMemoryStore,
    private embeddingService: EmbeddingService,
    private rerankerService: RerankerService,
  ) { }

  public async recall(params: {
    userId: string;
    sessionKey: string;
    query: string;
    activeSkill?: string;
    explain?: boolean;
    filters?: RecallFilters;
    /**
     * MEM-19 — per-call recall config overrides so callers (the retrieval
     * benchmark) can compare modes deterministically WITHOUT mutating
     * process.env. The old benchmark toggled BRAINROUTER_RECALL_* globally and
     * restored it in a finally, which leaked '20' across runs and flaked under
     * concurrency. These overrides layer over the env-read defaults.
     */
    limitsOverride?: Partial<RecallLimits>;
    selectionOverride?: Partial<RecallSelection>;
    /** Per-call reranker-blend override (0..1). Used by per-org recall settings;
     *  falls back to BRAINROUTER_RECALL_RERANK_BLEND_ALPHA when undefined. */
    rerankBlendAlphaOverride?: number;
    /** Per-call reflective-query-routing override. Used by per-org recall
     *  settings; falls back to BRAINROUTER_RECALL_QUERY_ROUTING when undefined. */
    queryRoutingOverride?: boolean;
    /** MEM-19 — force-disable the reranker stage for this call (the benchmark's
     * baseline vs rerank modes). */
    disableReranker?: boolean;
  }): Promise<RecallResult> {
    const startTime = Date.now();
    const { userId, sessionKey, query, activeSkill, filters } = params;
    const intent = detectTaskIntent(query);
    const limits = { ...readRecallLimits(), ...params.limitsOverride };
    const selection = { ...readRecallSelection(), ...params.selectionOverride };

    // ADR-010 P5b — org-shared recall. When the caller's org is set, retrieval
    // ALSO returns org-shared records (visibility='org') from that org; stamp the
    // caller so applyFilters' orgVisibilityAllows can enforce per-member privacy.
    // GATED: without filters.orgId this is exactly the prior user-only path.
    const orgId = filters?.orgId;
    if (filters?.orgId && !filters.callerUserId) filters.callerUserId = userId;
    // `searchCognitive*` gain an optional orgId in PostgresMemoryStore; the shared
    // IMemoryStore type doesn't carry it, so reach it through a narrow local cast.
    const orgStore = this.store as unknown as {
      searchCognitiveFts(userId: string, query: string, limit: number, orgId?: string): Promise<CognitiveFtsResult[]>;
      searchCognitiveVec(userId: string, queryEmbedding: Float32Array, limit: number, orgId?: string): Promise<VectorSearchResult[]>;
    };

    // Stage 1 has no cross-stream dependencies: begin FTS, filepath expansion,
    // and embedding/vector retrieval together, then fuse their completed results
    // below. Vector failure remains intentionally fail-open so an unavailable
    // embedder never makes keyword recall unavailable.
    const ftsResultsPromise = orgStore.searchCognitiveFts(userId, query, limits.ftsLimit, orgId);
    const filePathResultsPromise = this.expandWithFilePathMatches(userId, query);
    const vecResultsPromise: Promise<VectorSearchResult[]> = this.embeddingService.isReady()
      ? this.embeddingService.embed(query)
        .then((queryVec) => orgStore.searchCognitiveVec(userId, queryVec, limits.vecLimit, orgId))
        .catch((e) => {
          console.error("[BrainRouter] Vector search skipped during recall:", (e as Error).message);
          return [];
        })
      : Promise.resolve([]);
    const [ftsResultsRaw, filePathResultsRaw, vecResultsRaw] = await Promise.all([
      ftsResultsPromise,
      filePathResultsPromise,
      vecResultsPromise,
    ]);

    // Federation Stage 1 — when a workspace filter is set, pre-fetch the
    // workspace_tag for every candidate id once. The FTS5 virtual table
    // doesn't carry the tag (its schema is frozen), and adding it would
    // require a heavy reindex. A single batch SELECT against
    // cognitive_records is cheap (≤ ftsLimit + vecLimit + filePath ids,
    // typically ~30-50 ids) and keeps the FTS5 contract intact.
    let workspaceTagLookup: Map<string, string | null> | undefined;
    if (filters?.workspaceTag) {
      const candidateIds = new Set<string>();
      for (const r of ftsResultsRaw) candidateIds.add(r.record_id);
      for (const r of vecResultsRaw) candidateIds.add(r.record_id);
      for (const r of filePathResultsRaw) candidateIds.add(r.record_id);
      if (candidateIds.size > 0) {
        workspaceTagLookup = await this.store.getWorkspaceTagsByRecordIds(userId, [...candidateIds]);
      }
    }
    // AUG-A1 — same pre-fetch for the project tag when scope:'project'.
    let projectTagLookup: Map<string, string | null> | undefined;
    if (filters?.scope === "project" && filters?.projectTag) {
      const candidateIds = new Set<string>();
      for (const r of ftsResultsRaw) candidateIds.add(r.record_id);
      for (const r of vecResultsRaw) candidateIds.add(r.record_id);
      for (const r of filePathResultsRaw) candidateIds.add(r.record_id);
      if (candidateIds.size > 0) {
        projectTagLookup = await this.store.getProjectTagsByRecordIds(userId, [...candidateIds]);
      }
    }

    // ADR-017 D4 — per-project restricted ACL. Compute once the set of
    // project_tags of restricted Projects the caller may NOT access, and hand
    // it to applyFilters so their records are dropped. The store method is
    // optional on the shared IMemoryStore type — reach it via a narrow cast,
    // like the org-shared search above.
    if (filters?.orgId && filters.callerUserId && !filters.deniedProjectTags) {
      const aclStore = this.store as unknown as {
        listInaccessibleRestrictedProjectNames?(orgId: string, userId: string): Promise<string[]>;
      };
      if (typeof aclStore.listInaccessibleRestrictedProjectNames === "function") {
        const deniedNames = await aclStore.listInaccessibleRestrictedProjectNames(filters.orgId, filters.callerUserId);
        const deniedTags = new Set(
          deniedNames.map((n) => projectTagFromName(n)).filter((t): t is string => typeof t === "string"),
        );
        if (deniedTags.size > 0) filters.deniedProjectTags = deniedTags;
      }
    }

    // Filter the three candidate streams BEFORE RRF so the rank is computed
    // on the actually-relevant pool, not a filtered subset of an unfiltered
    // rank (which would bias scores toward records that happen to be in the
    // top-15 globally even if irrelevant to the filter).
    const ftsResults = applyFilters(ftsResultsRaw, filters, workspaceTagLookup, projectTagLookup, sessionKey);
    const vecResults = applyFilters(vecResultsRaw, filters, workspaceTagLookup, projectTagLookup, sessionKey);
    const filePathResults = applyFilters(filePathResultsRaw, filters, workspaceTagLookup, projectTagLookup, sessionKey);

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
        void this.writeRecallOp(userId, sessionKey, query, emptyStrategy, 0, durationMs, recallExplanation);
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

    // B7 (MEM-CHURN) — one churn lookup for the whole candidate set; records with
    // no code anchor or zero churn are absent → their decay stays unchanged.
    const churnByRecord = (await (this.store as Partial<{ getRecordsMaxChurn(userId: string, recordIds: string[]): Promise<Map<string, number>> }>)
      .getRecordsMaxChurn?.(userId, Array.from(rrfMap.keys()))) ?? new Map<string, number>();

    const scoredResults = Array.from(rrfMap.values()).map(({ record, rrfScore }) => {
      // AUG-A3 — weighting / boosting helpers from the modular `reranker/`.
      const baseScore = baseScoreFromRrf(rrfScore);
      // 0.4.3 — clamp the priority term for generic long-lived types
      // (instruction / architecture_decision / task_state) so never-decaying
      // boilerplate can't out-rank fresh, on-topic findings. No-op for the
      // task-specific types (no recallPriorityCap set).
      const priorityScore = capPriority(
        normalizePriority(effectivePriority(record as CognitiveFtsResult, churnByRecord.get(record.record_id))),
        getMemoryTypeConfig(record.type).recallPriorityCap,
      );
      let finalScore = blendBaseAndPriority(baseScore, priorityScore);

      if (activeSkill && record.skill_tag === activeSkill) {
        finalScore *= SKILL_BOOST;
        skillBoostApplied = true;
      }

      const intentMultiplier = intentBoost(getMemoryTypeConfig(record.type).intentAffinity[intent]);
      if (intentMultiplier !== 1) {
        typeBoosts[record.type] = intentMultiplier;
      }
      finalScore *= intentMultiplier;

      const citationCount = (record as CognitiveFtsResult).citation_count ?? 0;
      const citBoost = citationBoost(citationCount);
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
    const propagatedNodes = await sparkEngine.propagateSparks(userId, initialNodes);

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
        const record = await this.store.getMemoryById(userId, propNode.id);
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
    // Final result count when no reranker is configured (env:
    // BRAINROUTER_RECALL_TOP_RESULTS, default 5).
    let topResults = sparkScoredResults.slice(0, limits.topResults);

    // Stage 3 — Reranker pool (env: BRAINROUTER_RECALL_RERANK_POOL, default 20).
    // This is the pool of candidates handed to the cross-encoder; the
    // reranker itself outputs `BRAINROUTER_RERANKER_TOP_N` rows (already
    // configurable).
    const rerankCandidates = sparkScoredResults.slice(0, limits.rerankPool);
    let usedReranker = false;
    let usedLexicalSelection = false;

    // MEM-ROUTE (0.4.14) — skip the cross-encoder for reflective/analytical
    // queries; their low-overlap gold retrieves better without it (it gets
    // demoted), so they fall through to the MMR selection path below.
    const queryRoutingEnabled = params.queryRoutingOverride ?? readQueryRoutingEnabled();
    const routeReflective = queryRoutingEnabled && isReflectiveQuery(query);
    // isAvailable() (not isReady) so a tripped circuit breaker skips the
    // cross-encoder entirely during its cooldown — recall uses RRF with no
    // per-call network wait, instead of paying the reranker timeout every turn.
    if (this.rerankerService.isAvailable() && !params.disableReranker && !routeReflective) {
      try {
        // MEM-RERANK2 (0.4.14) — only a char-budgeted head goes to the
        // cross-encoder (the recall-latency bottleneck, longmemeval 22-28s).
        // Budgeting by chars (not a fixed count) adapts to doc length: long-doc
        // corpora send few candidates (latency cut; their gold is shallow),
        // short-doc corpora send the whole pool (deep gold still rescued). The
        // tail keeps its pre-score order and is appended — no recall loss.
        const headSize = rerankHeadSize(
          rerankCandidates.map((r) => String(r.record.content ?? "").length),
          readRerankCharBudget(),
          rerankerMaxDocChars(),
        );
        const head = rerankCandidates.slice(0, headSize);
        const tail = rerankCandidates.slice(headSize);
        const documents = head.map(r => r.record.content);
        // MEM-BLEND (0.4.14) — score the whole head, then blend the cross-encoder
        // order with the pre-rerank order (RRF + half-life recency) by reciprocal
        // rank instead of letting the reranker *replace* it. Keeps recency in play
        // (a recency baseline can't beat us) and stops low-similarity reflective
        // gold from being demoted. alpha=1 reproduces the legacy pure-reranker order.
        const ranked = await this.rerankerService.rerank({
          query,
          documents,
          topN: head.length,
        });
        // rerankRank[i] = head item i's position in the reranker order (lower = better).
        const rerankRank = new Array(head.length).fill(head.length);
        ranked.forEach((r, pos) => {
          if (Number.isInteger(r.index) && r.index >= 0 && r.index < rerankRank.length) {
            rerankRank[r.index] = pos;
          }
        });
        const outN = Math.max(1, this.rerankerService.getTopN());
        const headOrder = blendByRank(rerankRank, params.rerankBlendAlphaOverride ?? readRerankBlendAlpha());
        topResults = [...headOrder.map((i) => head[i]), ...tail].slice(0, outN);
        usedReranker = true;
      } catch (e) {
        console.error("[BrainRouter] Reranker failed during recall, falling back to RRF:", (e as Error).message);
      }
    }

    // Stage 3b (0.4.3) — no cross-encoder configured (the default install):
    // run a local, no-network selection over the candidate pool. Demote
    // records that share few salient tokens with the query (generic boilerplate
    // → ~0 overlap), then MMR-select for diversity — which also collapses
    // near-duplicate records (5× "BrainRouter is an autonomous agent" → 1) so
    // they can't fill the top-K. Zero added latency (token-set math only).
    if (!usedReranker && selection.diversity) {
      const qTokens = tokenSet(query);
      const mmrCandidates: MmrCandidate<typeof rerankCandidates[number]>[] = rerankCandidates.map((r) => {
        const docTokens = tokenSet(String(r.record.content ?? ""));
        const lex = lexicalOverlap(qTokens, docTokens);
        const adjusted = r.score * (LEXICAL_SCORE_FLOOR + (1 - LEXICAL_SCORE_FLOOR) * lex);
        return { item: r, score: adjusted, tokens: docTokens };
      });
      topResults = selectMMR(mmrCandidates, limits.topResults, selection.lambda);
      usedLexicalSelection = true;
    }

    // MEM-17 — gather expansion refs (source chunks + covering tree node) once
    // per recalled record; reused for both the briefing hint and the result objects.
    const refsByRecord = new Map(
      await Promise.all(
        topResults.map(async ({ record }): Promise<[string, Awaited<ReturnType<typeof gatherRecordRefs>>]> => [
          record.record_id,
          await gatherRecordRefs(this.store as RecordRefsStore, userId, record.record_id),
        ]),
      ),
    );

    // MEM-ACCURACY (0.4.7) — within the selected set, sink records whose source
    // code changed since capture (provenance document marked stale) so FRESH
    // memories surface first. Stable (V8 sort) → preserves the ranked order
    // inside each group. The "⚠ source changed — verify" annotation (below) is
    // the primary signal; this just stops a stale memory leading the block.
    topResults.sort((a, b) => {
      const sa = refsByRecord.get(a.record.record_id)?.staleVsCode ? 1 : 0;
      const sb = refsByRecord.get(b.record.record_id)?.staleVsCode ? 1 : 0;
      return sa - sb;
    });

    // 5. Format for context
    const memoryLines = topResults.map(({ record }) => {
      const tag = record.scene_name ? `${record.type}|${record.scene_name}` : record.type;
      let line = `- [${tag}] ${record.content}`;
      if (record.skill_tag) {
        line += ` (skill: ${record.skill_tag})`;
      }
      // MEM-17 — one-hop drill-down hint (source chunk ids + tree node), if any.
      const hint = formatRefHint(refsByRecord.get(record.record_id) ?? { sourceChunkIds: [], treeNodeId: null, staleVsCode: false });
      if (hint) line += `\n${hint}`;
      return line;
    });

    // If nothing survived selection, skip the prepend block entirely —
    // an empty <relevant-memories> tag is worse than no tag because it
    // implies "we looked and nothing helped," which the agent should infer
    // from the absence of the block.
    const prependContext = memoryLines.length > 0
      ? `<relevant-memories>\n  The following memories are relevant to this query. Reference only if helpful:\n\n  ${memoryLines.join("\n  ")}\n</relevant-memories>`
      : undefined;

    const recalledCognitiveMemories: RecalledMemory[] = topResults.map(r => {
      const refs = refsByRecord.get(r.record.record_id);
      return {
        content: r.record.content,
        score: r.score,
        type: r.record.type,
        recordId: r.record.record_id,
        skillTag: r.record.skill_tag,
        // MEM-17 — expansion handles; omit empties so the shape stays lean.
        ...(refs && refs.sourceChunkIds.length > 0 ? { sourceChunkIds: refs.sourceChunkIds } : {}),
        ...(refs && refs.treeNodeId ? { treeNodeId: refs.treeNodeId } : {}),
        // MEM-ACCURACY — flag records whose source code changed since capture.
        ...(refs && refs.staleVsCode ? { staleVsCode: true } : {}),
      };
    });
    const recallCompression = await applyRecallCompression(recalledCognitiveMemories, {
      userId,
      query,
      store: this.store as unknown as import("../compression/router.js").CompressionStore,
      config: readRecallCompressionConfig(),
    });

    // Build appendSystemContext with Contextual Focus Navigation + tools guide
    const topScenes = await this.store.getTopContextualFocus(userId, 3);
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
  To drill into a memory's "↳ source" refs: memory_fetch_source_chunk(<chunkId>) for the exact source, memory_tree_walk(<treeNodeId>) for its summary tree.
  To explore code neighbours: memory_find_related(<chunkId> | file+line) for the nearest related code chunks across files.
  Max 3 memory tool calls per turn.
</memory-tools-guide>`;

    if (recallCompression.compressedCount > 0) {
      appendSystemContext += `\n${RECALL_COMPRESSION_NOTE}`;
    }

    // Graph context expansion (2-hop BFS from matched entities)
    const graphContext = await expandRecallWithGraph({
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
        const prewarmResults = await detectPrewarmSkills({
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

    const baseStrategy = vecResults.length > 0
      ? (usedReranker ? "hybrid+rerank" : "hybrid")
      : (usedReranker ? "keyword+rerank" : (filePathResults.length > 0 ? "keyword+file" : "keyword"));
    // Surface the 0.4.3 local selection stage in the strategy label (no shared-
    // type change): "+lexmmr" = lexical-relevance demotion + MMR diversity ran.
    const selectStrategy = usedLexicalSelection ? `${baseStrategy}+lexmmr` : baseStrategy;
    const recallStrategy = selectStrategy;

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
      diversityApplied: usedLexicalSelection,
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
      void this.writeRecallOp(userId, sessionKey, query, recallStrategy, topResults.length, durationMs, recallExplanation);
    }

    return {
      prependContext,
      appendSystemContext,
      recalledCognitiveMemories: recallCompression.memories,
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

  private async writeRecallOp(
    userId: string,
    sessionKey: string,
    query: string,
    strategy: string,
    hitCount: number,
    durationMs: number,
    explanation?: RecallExplanation
  ) {
    try {
      await this.store.insertOperation({
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

  private async expandWithFilePathMatches(userId: string, query: string): Promise<CognitiveFtsResult[]> {
    const filePaths = extractFilePathHints(query);
    if (filePaths.length === 0) return [];

    const records = new Map<string, CognitiveRecord>();
    for (const filePath of filePaths) {
      for (const record of await this.store.getMemoriesByFilePath(userId, filePath, 10)) {
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

import type { IMemoryStore } from "@kinqs/brainrouter-types";
import type { RecallResult, CognitiveFtsResult, RecalledMemory, VectorSearchResult, CognitiveRecord, RecallExplanation, RelevanceVerdict } from "@kinqs/brainrouter-types";
import type { EmbeddingService } from "./store/embedding.js";
import type { RerankerService } from "./store/reranker.js";
import type { RelevanceJudgeService } from "./store/relevance-judge.js";
import { expandRecallWithGraph } from "./pipeline/graph-recall.js";
import { detectPrewarmSkills, buildPrewarmBlock } from "./pipeline/skill-prewarm.js";
import { detectTaskIntent, extractFilePathHints, getMemoryTypeConfig } from "./memory-type-config.js";
import { randomUUID } from "node:crypto";
import { NeuralSparkEngine } from "./pipeline/neural-spark.js";
import { isExternalTimeoutError } from "./llm-response.js";
import {
  effectivePriorityScore,
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
} from "./reranker/index.js";

/**
 * Recall pipeline limit knobs. Each stage of the pipeline has a width
 * (how many candidates flow through) — these used to be hardcoded
 * `15 / 15 / 20 / 5` in this file, which meant any user wanting more
 * recall coverage had to patch the source. Now env-overridable:
 *
 *   BRAINROUTER_RECALL_FTS_LIMIT      (default 15)  Stage 1 FTS5 top-K
 *   BRAINROUTER_RECALL_VEC_LIMIT      (default 15)  Stage 1 vector top-K
 *   BRAINROUTER_RECALL_RERANK_POOL    (default 20)  Stage 2 reranker pool size
 *   BRAINROUTER_RECALL_TOP_RESULTS    (default 5)   final size when reranker is off
 *
 * Each is clamped to [1, 200] to keep a typo from blowing up the
 * downstream LLM-judge call. Reading env once per recall is fine —
 * recall is already an LLM-grade operation, the env read is in the
 * noise.
 */
function recallLimit(envName: string, defaultValue: number, max = 200): number {
  const raw = process.env[envName];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
  return Math.min(parsed, max);
}

export interface RecallLimits {
  ftsLimit: number;
  vecLimit: number;
  rerankPool: number;
  topResults: number;
}

export const RECALL_LIMITS_DEFAULT: RecallLimits = {
  ftsLimit: 15,
  vecLimit: 15,
  rerankPool: 20,
  topResults: 5,
};

export function readRecallLimits(): RecallLimits {
  return {
    ftsLimit: recallLimit('BRAINROUTER_RECALL_FTS_LIMIT', RECALL_LIMITS_DEFAULT.ftsLimit),
    vecLimit: recallLimit('BRAINROUTER_RECALL_VEC_LIMIT', RECALL_LIMITS_DEFAULT.vecLimit),
    rerankPool: recallLimit('BRAINROUTER_RECALL_RERANK_POOL', RECALL_LIMITS_DEFAULT.rerankPool),
    topResults: recallLimit('BRAINROUTER_RECALL_TOP_RESULTS', RECALL_LIMITS_DEFAULT.topResults),
  };
}

/**
 * 0.4.3 — selection-stage config for the no-cross-encoder (default) path:
 * lexical relevance demotion + MMR diversity. Both ON by default; tune via
 *   BRAINROUTER_RECALL_DIVERSITY        on|off  (default on)
 *   BRAINROUTER_RECALL_DIVERSITY_LAMBDA 0..1    (default 0.7 — relevance-leaning)
 * No effect when a cross-encoder reranker key is configured (that path wins).
 */
export interface RecallSelection {
  diversity: boolean;
  lambda: number;
}

export function readRecallSelection(env: NodeJS.ProcessEnv = process.env): RecallSelection {
  const diversity = env.BRAINROUTER_RECALL_DIVERSITY?.trim().toLowerCase() !== 'off';
  const rawLambda = Number.parseFloat(env.BRAINROUTER_RECALL_DIVERSITY_LAMBDA ?? '');
  const lambda = Number.isFinite(rawLambda) && rawLambda >= 0 && rawLambda <= 1 ? rawLambda : 0.7;
  return { diversity, lambda };
}

function effectivePriority(memory: CognitiveFtsResult & { citation_count?: number }): number {
  const halfLife = getMemoryTypeConfig(memory.type).halfLifeDays;
  const ageDays = (Date.now() - new Date(memory.created_time).getTime()) / 86_400_000;
  // AUG-A3 — score-composition math lives in the modular `reranker/` package.
  return effectivePriorityScore({
    priority: memory.priority,
    ageDays,
    halfLifeDays: halfLife,
    citationCount: memory.citation_count,
  });
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
  /**
   * Federation Stage 1 (0.4.0) — restrict to records captured in this
   * workspace. NULL-tolerant on both sides: a record with no tag is
   * never filtered out (legacy / pre-migration rows surface in every
   * workspace), and a missing filter likewise surfaces every record.
   * Pass `workspaceTagFromPath(root)` to compute the canonical tag.
   */
  workspaceTag?: string;
  /**
   * AUG-A1 (0.4.1) — restrict to records captured under this Project tag
   * (a `.brainrouter/project.json` name, hashed via `projectTagFromName`).
   * Same NULL-tolerant semantics as `workspaceTag`: untagged records and a
   * missing filter both surface. Used when `scope: 'project'`.
   */
  projectTag?: string;
  /**
   * AUG-A1 — recall scope. `'workspace'` (default) keeps the existing
   * workspace-tag behaviour; `'project'` widens to the active project
   * (filtering by `projectTag` instead of `workspaceTag`).
   */
  scope?: "project" | "workspace";
}

export function applyFilters<T extends CognitiveFtsResult | VectorSearchResult>(
  records: T[],
  filters?: RecallFilters,
  workspaceTagLookup?: Map<string, string | null>,
  projectTagLookup?: Map<string, string | null>,
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
    if (filters.workspaceTag) {
      // NULL-tolerant on both sides — a record with no captured tag
      // (legacy / pre-migration) surfaces in every workspace, and a
      // missing filter (handled above by `!filters`) likewise surfaces
      // every record. Federation rollout is gradual: as soon as a peer
      // CLI starts tagging new captures, those records get scoped; old
      // ones keep flowing through until they're re-extracted.
      const tag =
        (r as { workspace_tag?: string | null }).workspace_tag ??
        workspaceTagLookup?.get(r.record_id) ??
        null;
      if (tag !== null && tag !== filters.workspaceTag) return false;
    }
    if (filters.scope === "project" && filters.projectTag) {
      // Same NULL-tolerant rule as workspaceTag: untagged records surface
      // under any project so the rollout is gradual.
      const ptag =
        (r as { project_tag?: string | null }).project_tag ??
        projectTagLookup?.get(r.record_id) ??
        null;
      if (ptag !== null && ptag !== filters.projectTag) return false;
    }
    return true;
  });
}

export class MemoryRecallPipeline {
  constructor(
    private store: IMemoryStore,
    private embeddingService: EmbeddingService,
    private rerankerService: RerankerService,
    private relevanceJudge?: RelevanceJudgeService,
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
    const limits = readRecallLimits();
    const selection = readRecallSelection();

    // 1. FTS5 BM25 search (Top-K, env: BRAINROUTER_RECALL_FTS_LIMIT)
    const ftsResultsRaw = this.store.searchCognitiveFts(userId, query, limits.ftsLimit);
    const filePathResultsRaw = this.expandWithFilePathMatches(userId, query);

    // 2. Vector search (Top-K, env: BRAINROUTER_RECALL_VEC_LIMIT)
    let vecResultsRaw: VectorSearchResult[] = [];
    if (this.embeddingService.isReady()) {
      try {
        const queryVec = await this.embeddingService.embed(query);
        vecResultsRaw = this.store.searchCognitiveVec(userId, queryVec, limits.vecLimit);
      } catch (e) {
        console.error("[BrainRouter] Vector search skipped during recall:", (e as Error).message);
      }
    }

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
        workspaceTagLookup = this.store.getWorkspaceTagsByRecordIds(userId, [...candidateIds]);
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
        projectTagLookup = this.store.getProjectTagsByRecordIds(userId, [...candidateIds]);
      }
    }

    // Filter the three candidate streams BEFORE RRF so the rank is computed
    // on the actually-relevant pool, not a filtered subset of an unfiltered
    // rank (which would bias scores toward records that happen to be in the
    // top-15 globally even if irrelevant to the filter).
    const ftsResults = applyFilters(ftsResultsRaw, filters, workspaceTagLookup, projectTagLookup);
    const vecResults = applyFilters(vecResultsRaw, filters, workspaceTagLookup, projectTagLookup);
    const filePathResults = applyFilters(filePathResultsRaw, filters, workspaceTagLookup, projectTagLookup);

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
      // AUG-A3 — weighting / boosting helpers from the modular `reranker/`.
      const baseScore = baseScoreFromRrf(rrfScore);
      // 0.4.3 — clamp the priority term for generic long-lived types
      // (instruction / architecture_decision / task_state) so never-decaying
      // boilerplate can't out-rank fresh, on-topic findings. No-op for the
      // task-specific types (no recallPriorityCap set).
      const priorityScore = capPriority(
        normalizePriority(effectivePriority(record as CognitiveFtsResult)),
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

    // Stage 4 — LLM Relevance Judge (semantic approve/reject gate)
    //
    // The reranker orders candidates by a learned relevance score but never
    // *filters* — so a memory that shares vocabulary with the query but is
    // about a different subject still makes the cut. The judge fixes that by
    // asking a fast LLM "is each of these actually relevant?" and dropping
    // the rejects. On any failure we keep the reranker output unchanged so a
    // flaky judge call never breaks recall.
    let judgeUsed = false;
    let judgeApproved = 0;
    let judgeRejected = 0;
    let judgeVerdicts: RelevanceVerdict[] | undefined;

    if (this.relevanceJudge?.isReady() && topResults.length > 0) {
      try {
        const judgeCandidates = topResults.map(r => ({
          id: r.record.record_id,
          content: r.record.content,
        }));
        const judgeResult = await this.relevanceJudge.judge({ query, candidates: judgeCandidates });
        judgeUsed = true;
        judgeVerdicts = judgeResult.verdicts;
        judgeApproved = judgeResult.approvedIndices.length;
        judgeRejected = topResults.length - judgeApproved;
        topResults = judgeResult.approvedIndices.map((i) => topResults[i]);
      } catch (e) {
        // Locally-hosted LLMs (LM Studio, Ollama) timing out on the
        // relevance judge isn't a server bug — it just means the
        // judge model is slow. Tone the message down to a single warn
        // line (no stack trace) so it doesn't dump several frames of
        // noise into the CLI's terminal on every recall. Non-timeout
        // failures still get the full error for diagnostics.
        if (isExternalTimeoutError(e)) {
          console.warn("[BrainRouter] Relevance judge timed out; keeping reranker output.");
        } else {
          console.error("[BrainRouter] Relevance judge failed during recall, keeping reranker output:", (e as Error).message);
        }
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

    // If the judge rejected everything, skip the prepend block entirely —
    // an empty <relevant-memories> tag is worse than no tag because it
    // implies "we looked and nothing helped," which the agent should infer
    // from the absence of the block.
    const prependContext = memoryLines.length > 0
      ? `<relevant-memories>\n  The following memories are relevant to this query. Reference only if helpful:\n\n  ${memoryLines.join("\n  ")}\n</relevant-memories>`
      : undefined;

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

    const baseStrategy = vecResults.length > 0
      ? (usedReranker ? "hybrid+rerank" : "hybrid")
      : (usedReranker ? "keyword+rerank" : (filePathResults.length > 0 ? "keyword+file" : "keyword"));
    // Surface the 0.4.3 local selection stage in the strategy label (no shared-
    // type change): "+lexmmr" = lexical-relevance demotion + MMR diversity ran.
    const selectStrategy = usedLexicalSelection ? `${baseStrategy}+lexmmr` : baseStrategy;
    const recallStrategy = judgeUsed ? `${selectStrategy}+judge` : selectStrategy;

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
      judgeUsed,
      judgeApproved,
      judgeRejected,
      judgeVerdicts,
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
          judgeUsed: explanation?.judgeUsed ?? false,
          judgeApproved: explanation?.judgeApproved ?? 0,
          judgeRejected: explanation?.judgeRejected ?? 0,
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

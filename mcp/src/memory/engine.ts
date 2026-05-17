import { SqliteMemoryStore } from "./store/sqlite.js";
import { MemoryCapturePipeline } from "./capture.js";
import { MemoryRecallPipeline } from "./recall.js";
import { EmbeddingService } from "./store/embedding.js";
import { RerankerService } from "./store/reranker.js";
import { scanSkillsForHints } from "./skill-hints-loader.js";
import { distillScenes } from "./pipeline/l2-scene.js";
import { distillPersona } from "./pipeline/l3-distiller.js";
import type { LLMRunner, LLMRunParams } from "./types.js";
import "dotenv/config";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Configure default path
const defaultDbPath = process.env.BRAINROUTER_MEMORY_DB || path.join(os.homedir(), ".brainrouter", "memory.db");

// Configurable LLM Runner — supports per-task model routing
// Fallback chain: modelOverride → BRAINROUTER_LLM_MODEL → "gpt-4o-mini"
class ModelLLMRunner implements LLMRunner {
  private readonly modelOverride?: string;

  constructor(modelOverride?: string) {
    // Treat empty string as "not set" so env vars don't accidentally blank the model
    this.modelOverride = modelOverride?.trim() || undefined;
  }

  async run({ prompt, systemPrompt, timeoutMs = 120_000, taskId }: LLMRunParams): Promise<string> {
    const endpoint = process.env.BRAINROUTER_LLM_ENDPOINT ?? "https://api.openai.com/v1/chat/completions";
    const apiKey = process.env.BRAINROUTER_LLM_API_KEY;

    if (!apiKey) {
      throw new Error(`[BrainRouter:${taskId}] BRAINROUTER_LLM_API_KEY is not set. Memory extraction requires an LLM.`);
    }

    // Fallback chain: constructor override → env BRAINROUTER_LLM_MODEL → hard default
    const model = this.modelOverride
      ?? (process.env.BRAINROUTER_LLM_MODEL?.trim() || undefined)
      ?? "gpt-4o-mini";

    const messages: { role: string; content: string }[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`[BrainRouter:${taskId}] LLM Error (${model}): ${res.status} ${res.statusText} - ${errorBody}`);
    }

    const data = await res.json() as any;
    return data.choices[0].message.content;
  }
}


export class MemoryEngine {
  private store: SqliteMemoryStore;
  private capturePipeline: MemoryCapturePipeline;
  private recallPipeline: MemoryRecallPipeline;
  // Extraction runner: L1, L1.5, GraphRAG — should be fast/cheap
  private extractionRunner: LLMRunner;
  // Synthesis runner: L2 scenes, L3 persona — can be smarter/larger
  private synthesisRunner: LLMRunner;

  private personaCache: Map<string, { personaMd: string; cachedAt: number }> = new Map();
  private readonly PERSONA_CACHE_TTL_MS = parseInt(
    process.env.BRAINROUTER_PERSONA_CACHE_TTL_MS ?? String(60 * 60 * 1000), 10
  );
  
  constructor(dbPath: string = defaultDbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.store = new SqliteMemoryStore(dbPath);
    this.store.init();

    // Extraction runner: BRAINROUTER_EXTRACTION_MODEL → BRAINROUTER_LLM_MODEL → "gpt-4o-mini"
    this.extractionRunner = new ModelLLMRunner(
      process.env.BRAINROUTER_EXTRACTION_MODEL
    );
    // Synthesis runner: BRAINROUTER_SYNTHESIS_MODEL → BRAINROUTER_LLM_MODEL → "gpt-4o-mini"
    // When same model is desired (default), simply don't set BRAINROUTER_SYNTHESIS_MODEL
    this.synthesisRunner = new ModelLLMRunner(
      process.env.BRAINROUTER_SYNTHESIS_MODEL
    );
    
    const embeddingService = new EmbeddingService({
      endpoint: process.env.BRAINROUTER_EMBEDDING_ENDPOINT,
      apiKey: process.env.BRAINROUTER_EMBEDDING_API_KEY ?? process.env.BRAINROUTER_LLM_API_KEY,
      model: process.env.BRAINROUTER_EMBEDDING_MODEL,
      dimensions: process.env.BRAINROUTER_EMBEDDING_DIMENSIONS ? parseInt(process.env.BRAINROUTER_EMBEDDING_DIMENSIONS, 10) : undefined,
    });

    const rerankerService = new RerankerService({
      endpoint: process.env.BRAINROUTER_RERANKER_ENDPOINT,
      apiKey: process.env.BRAINROUTER_RERANKER_API_KEY,
      model: process.env.BRAINROUTER_RERANKER_MODEL,
      topN: process.env.BRAINROUTER_RERANKER_TOP_N 
        ? parseInt(process.env.BRAINROUTER_RERANKER_TOP_N, 10) 
        : undefined,
    });

    this.store.initVec(embeddingService.getDimensions());
    
    this.capturePipeline = new MemoryCapturePipeline(this.store, this.extractionRunner, embeddingService, 1);
    this.recallPipeline = new MemoryRecallPipeline(this.store, embeddingService, rerankerService);
  }

  public get capture() {
    return this.capturePipeline.captureTurn.bind(this.capturePipeline);
  }

  public get recall() {
    return async (params: Parameters<MemoryRecallPipeline['recall']>[0]) => {
      const result = await this.recallPipeline.recall(params);
      
      // Inject persona from cache — prepend so it's stable at the top of appendSystemContext
      // Guard against undefined (returned on empty-recall fast-path)
      const persona = this.getPersona(params.userId);
      if (persona) {
        const existing = result.appendSystemContext ?? "";
        result.appendSystemContext = `<user-persona>\n${persona.personaMd}\n</user-persona>\n\n` + existing;
        result.personaSummary = persona.personaMd;
      }
      
      return result;
    };
  }

  public getPendingContradictions(userId: string) {
    return this.store.getPendingContradictions(userId);
  }

  public resolveContradiction(id: string, userId: string, status: 'resolved' | 'dismissed') {
    return this.store.resolveContradiction(id, userId, status);
  }

  public registerSkillHints(skillName: string, hints: string, sourceFile = "") {
    this.store.upsertSkillHints(skillName, hints, sourceFile);
  }

  public listSkillHints() {
    return this.store.listSkillHints();
  }

  /**
   * Scan global + local skills directories for SKILL.md files with memory_hints
   * and auto-register them into the DB. Called once at startup.
   */
  public autoScanSkillHints(skillsDirs: string[]) {
    let loaded = 0;
    for (const dir of skillsDirs) {
      if (!fs.existsSync(dir)) continue;
      const found = scanSkillsForHints(dir);
      for (const item of found) {
        const skillName = item.name || path.basename(path.dirname(item.filePath));
        this.store.upsertSkillHints(skillName, item.hints, item.filePath);
        loaded++;
      }
    }
    if (loaded > 0) {
      console.error(`[BrainRouter] Auto-loaded memory_hints for ${loaded} skill(s).`);
    }
  }

  /** On-demand L2 scene distillation — groups L1s by scene and summarizes via LLM. */
  public async distillScenes(userId: string) {
    return distillScenes({ userId, store: this.store, llmRunner: this.synthesisRunner });
  }

  /** On-demand L3 persona distillation — cross-session synthesis of persona+instruction L1s. */
  public async distillPersona(userId: string) {
    const result = await distillPersona({ userId, store: this.store, llmRunner: this.synthesisRunner });
    if (result.success && result.personaMd) {
      this.personaCache.set(userId, { personaMd: result.personaMd, cachedAt: Date.now() });
    }
    return result;
  }

  /** Get the current L3 persona for a user, using prompt-level in-memory cache. */
  public getPersona(userId: string) {
    const cached = this.personaCache.get(userId);
    if (cached && (Date.now() - cached.cachedAt) < this.PERSONA_CACHE_TTL_MS) {
      return { personaMd: cached.personaMd };
    }
    
    const persona = this.store.getL3Persona(userId);
    if (persona) {
      this.personaCache.set(userId, { personaMd: persona.personaMd, cachedAt: Date.now() });
    }
    return persona;
  }

  /** Get the top N active scenes for a user (ordered by heat score). */
  public getTopScenes(userId: string, limit = 3) {
    return this.store.getTopL2Scenes(userId, limit);
  }

  /** Expose the ability to query the knowledge graph for a user/entity. */
  public queryGraph(userId: string, entity: string, skillTag?: string, maxHops = 2) {
    const node = this.store.getGraphNodeByEntity(userId, entity);
    if (!node) return { nodes: [], edges: [] };
    return this.store.getGraphNeighbors(userId, node.id, skillTag, maxHops);
  }

  // ============================
  // ACE Feedback Loop
  // ============================

  private readonly ACE_ARCHIVE_THRESHOLD = (() => {
    const v = parseInt(process.env.BRAINROUTER_ACE_ARCHIVE_THRESHOLD ?? "10", 10);
    // 0 means disabled; NaN or negative also disables
    return isNaN(v) || v <= 0 ? 0 : v;
  })();

  /**
   * Mark specific recalled memories as cited, and track non-cited ones.
   *
   * @param userId - The user who owns the memories
   * @param citedRecordIds - IDs of memories the agent actually used in its response
   * @param allRecalledRecordIds - All IDs surfaced during the previous recall (superset)
   *
   * Edge cases:
   * - citedRecordIds ⊄ allRecalledRecordIds: both sets processed independently (cited always wins)
   * - stale IDs not in DB: SQL IN() skips them silently
   * - ACE_ARCHIVE_THRESHOLD = 0: auto-archive is disabled
   */
  public markCited(userId: string, citedRecordIds: string[], allRecalledRecordIds: string[]) {
    // Cited memories: increment citation_count, reset never_cited_count
    if (citedRecordIds.length > 0) {
      this.store.markCited(userId, citedRecordIds);
    }

    // Non-cited recalled memories: increment never_cited_count
    const citedSet = new Set(citedRecordIds);
    const nonCited = allRecalledRecordIds.filter(id => !citedSet.has(id));

    if (nonCited.length > 0) {
      const updated = this.store.incrementNeverCited(userId, nonCited);

      // Auto-archive if threshold is enabled and exceeded
      if (this.ACE_ARCHIVE_THRESHOLD > 0) {
        for (const { recordId, neverCitedCount } of updated) {
          if (neverCitedCount >= this.ACE_ARCHIVE_THRESHOLD) {
            this.store.archiveL1Record(userId, recordId);
            console.error(`[BrainRouter] ACE: Auto-archived memory ${recordId} (never_cited_count=${neverCitedCount})`);
          }
        }
      }
    }

    return {
      cited: citedRecordIds.length,
      nonCited: nonCited.length,
      archiveThreshold: this.ACE_ARCHIVE_THRESHOLD,
    };
  }

  // ============================
  // Point-in-Time Search (asOf)
  // ============================

  /**
   * Search memories that were valid at a specific ISO timestamp.
   * Returns formatted context string (same shape as recall for easy comparison).
   *
   * @throws Error if asOf is not a parseable ISO date string
   */
  public searchAsOf(userId: string, query: string, asOf: string, limit = 10): {
    memories: Array<{ recordId: string; content: string; type: string; score: number }>;
    asOf: string;
    count: number;
  } {
    // Validate asOf is a parseable date
    const ts = Date.parse(asOf);
    if (isNaN(ts)) {
      throw new Error(`Invalid asOf timestamp: "${asOf}". Must be a valid ISO 8601 date string.`);
    }

    const results = this.store.searchL1FtsAsOf(userId, query, limit, asOf);
    return {
      memories: results.map(r => ({
        recordId: r.record_id,
        content: r.content,
        type: r.type,
        score: r.score,
      })),
      asOf,
      count: results.length,
    };
  }
}


// Singleton export
export const memoryEngine = new MemoryEngine();

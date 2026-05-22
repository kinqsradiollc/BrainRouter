/**
 * LongMemEval-S Benchmark script for BrainRouter Memory Engine.
 * 
 * Tests retrieval recall performance.
 * Run with: npx tsx benchmark/longmemeval-bench.ts [fts|hybrid|hybrid+rerank]
 */

import "dotenv/config";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SqliteMemoryStore } from "../src/memory/store/sqlite.js";
import { recallAny, ndcg, mrr, aggregate, type BenchResult } from "./lib/metrics.js";
import { getIncrementalOutputDir } from "./lib/output-dir.js";
import { TransformersEmbedder } from "./lib/transformers-embedder.js";
import { EmbeddingService } from "../src/memory/store/embedding.js";
import { RerankerService } from "../src/memory/store/reranker.js";
import type { L1FtsResult, VectorSearchResult } from "../src/memory/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface LongMemEvalEntry {
  question_id: string;
  question_type: string;
  question: string;
  answer_session_ids: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
}

interface SessionChunk {
  sessionId: string;
  text: string;
  turnCount: number;
}

function chunkSessionToText(turns: Array<{ role: string; content: string }>): string {
  return turns.map((t) => `${t.role}: ${t.content}`).join("\n");
}

async function runBenchmark(mode: "fts" | "hybrid" | "hybrid+rerank") {
  const dataPath = resolve(__dirname, "data", "longmemeval_s_cleaned.json");
  if (!existsSync(dataPath)) {
    console.error(`Dataset not found at ${dataPath}`);
    console.error("Run: npm run bench:download-data");
    process.exit(1);
  }

  console.log(`Loading LongMemEval-S dataset...`);
  const raw = JSON.parse(readFileSync(dataPath, "utf-8")) as LongMemEvalEntry[];

  // Same abstention filter
  const abstentionTypes = new Set([
    "single-session-user_abs",
    "multi-session_abs",
    "knowledge-update_abs",
    "temporal-reasoning_abs",
  ]);
  const entries = raw.filter((e) => !abstentionTypes.has(e.question_type));
  console.log(`Loaded ${entries.length} questions (${raw.length - entries.length} abstention excluded)`);

  let embedder: TransformersEmbedder | EmbeddingService | null = null;
  let reranker: RerankerService | null = null;

  if (mode === "hybrid" || mode === "hybrid+rerank") {
    // 1. Check if we have local/custom embedding configurations in .env
    const hasBrainRouterEnv = !!(process.env.BRAINROUTER_EMBEDDING_ENDPOINT || process.env.BRAINROUTER_EMBEDDING_API_KEY);
    const hasOpenAiEnv = !!process.env.OPENAI_API_KEY;

    if (hasBrainRouterEnv) {
      console.log(`Using EmbeddingService with custom local model: ${process.env.BRAINROUTER_EMBEDDING_MODEL || "default"}`);
      embedder = new EmbeddingService({
        endpoint: process.env.BRAINROUTER_EMBEDDING_ENDPOINT,
        apiKey: process.env.BRAINROUTER_EMBEDDING_API_KEY ?? process.env.BRAINROUTER_LLM_API_KEY,
        model: process.env.BRAINROUTER_EMBEDDING_MODEL,
        dimensions: process.env.BRAINROUTER_EMBEDDING_DIMENSIONS 
          ? parseInt(process.env.BRAINROUTER_EMBEDDING_DIMENSIONS, 10) 
          : undefined,
      });
    } else if (hasOpenAiEnv) {
      console.log("Using EmbeddingService via OPENAI_API_KEY");
      embedder = new EmbeddingService({
        apiKey: process.env.OPENAI_API_KEY,
        endpoint: process.env.OPENAI_BASE_URL,
        model: process.env.OPENAI_EMBEDDING_MODEL,
        dimensions: parseInt(process.env.OPENAI_EMBEDDING_DIMENSIONS || "1536", 10)
      });
    } else {
      console.log("Using fall-back Local TransformersEmbedder (all-MiniLM-L6-v2)");
      embedder = new TransformersEmbedder();
    }
  }

  // 2. Initialize Reranker Service if hybrid+rerank is requested
  if (mode === "hybrid+rerank") {
    const hasRerankEnv = !!process.env.BRAINROUTER_RERANKER_API_KEY;
    if (hasRerankEnv) {
      console.log(`Initializing RerankerService: ${process.env.BRAINROUTER_RERANKER_MODEL || "default"}`);
      reranker = new RerankerService({
        endpoint: process.env.BRAINROUTER_RERANKER_ENDPOINT,
        apiKey: process.env.BRAINROUTER_RERANKER_API_KEY,
        model: process.env.BRAINROUTER_RERANKER_MODEL,
        topN: process.env.BRAINROUTER_RERANKER_TOP_N 
          ? parseInt(process.env.BRAINROUTER_RERANKER_TOP_N, 10) 
          : undefined,
      });
    } else {
      console.error("[BrainRouter] Stage 3 reranking requested, but BRAINROUTER_RERANKER_API_KEY is not set. Falling back to RRF-only.");
    }
  }

  const results: BenchResult[] = [];
  let processed = 0;

  for (const entry of entries) {
    const sessionChunks: SessionChunk[] = [];
    for (let i = 0; i < entry.haystack_sessions.length; i++) {
      const sessionId = entry.haystack_session_ids[i];
      const turns = entry.haystack_sessions[i];
      sessionChunks.push({ sessionId, text: chunkSessionToText(turns), turnCount: turns.length });
    }

    // 1. Init in-memory DB for this question
    const store = new SqliteMemoryStore(":memory:");
    store.init();
    
    if (embedder && embedder.isReady()) {
      store.initVec(embedder.getDimensions());
    }

    const USER_ID = "bench_user";

    // 2. Load haystack into L1
    for (const chunk of sessionChunks) {
      const recordId = `rec_${chunk.sessionId}`;
      
      store.upsertL1({
        id: recordId,
        userId: USER_ID,
        sessionKey: "bench_session",
        sessionId: chunk.sessionId, // Keep sessionId to map back later
        content: chunk.text,
        type: "episodic",
        priority: 50,
        sceneName: "",
        skillTag: "",
        halfLifeDays: 30,
        supersededBy: null,
        invalidAt: null,
        timestampStr: new Date().toISOString(),
        timestampStart: "",
        timestampEnd: "",
        createdTime: new Date().toISOString(),
        updatedTime: new Date().toISOString(),
        metadata: {},
        citationCount: 0,
        lastCitedAt: null,
        neverCitedCount: 0,
        archived: false
      });

      if (embedder && store.isVecAvailable()) {
        try {
          const vec = await embedder.embed(chunk.text);
          store.upsertL1Vec(recordId, vec);
        } catch (e) {
          console.error(`Embed error on chunk ${chunk.sessionId}`, e);
        }
      }
    }

    // 3. Retrieval
    const TOP_K = 20;
    
    // FTS
    const ftsResults = store.searchL1Fts(USER_ID, entry.question, TOP_K);
    
    // Vector
    let vecResults: VectorSearchResult[] = [];
    if (embedder && store.isVecAvailable()) {
      try {
        const queryVec = await embedder.embed(entry.question);
        vecResults = store.searchL1Vec(USER_ID, queryVec, TOP_K);
      } catch (e) {
        // ignore
      }
    }

    let scoredResults: { recordId: string, sessionId: string, score: number }[] = [];

    if (mode === "fts") {
      // Just FTS, ordered by rank
      scoredResults = ftsResults.map(r => {
        // extract sessionId from DB
        const meta = store["stmtL1GetMeta"].get(r.record_id, USER_ID) as any;
        return { recordId: r.record_id, sessionId: meta.session_id, score: r.score };
      });
      // Ensure sorted by score
      scoredResults.sort((a, b) => b.score - a.score);
    } else {
      // Hybrid RRF
      const rrfMap = new Map<string, { recordId: string, sessionId: string, rrfScore: number }>();
      
      const addToRRF = (id: string, sessionId: string, rank: number) => {
        const existing = rrfMap.get(id);
        const score = 1 / (60 + rank);
        if (existing) {
          existing.rrfScore += score;
        } else {
          rrfMap.set(id, { recordId: id, sessionId, rrfScore: score });
        }
      };

      ftsResults.forEach((r, idx) => {
        const meta = store["stmtL1GetMeta"].get(r.record_id, USER_ID) as any;
        addToRRF(r.record_id, meta.session_id, idx + 1);
      });

      vecResults.forEach((r, idx) => {
        const meta = store["stmtL1GetMeta"].get(r.record_id, USER_ID) as any;
        addToRRF(r.record_id, meta.session_id, idx + 1);
      });

      scoredResults = Array.from(rrfMap.values()).map(r => ({
        recordId: r.recordId,
        sessionId: r.sessionId,
        score: r.rrfScore
      }));

      scoredResults.sort((a, b) => b.score - a.score);
    }

    // 4. Stage 3 Reranking: Apply local/custom reranker to top 20 candidates
    if (mode === "hybrid+rerank" && reranker && reranker.isReady()) {
      try {
        const candidates = scoredResults.slice(0, 20);
        const documents = candidates.map(c => {
          // Query L1 record metadata to get the original chunk text
          const record = store["stmtL1GetMeta"].get(c.recordId, USER_ID) as any;
          return record?.content || "";
        });

        const ranked = await reranker.rerank({
          query: entry.question,
          documents,
          topN: reranker.getTopN(),
        });

        // Map ranked results back to candidate indices
        const rerankedScoredResults = ranked.map(r => {
          const cand = candidates[r.index];
          return {
            recordId: cand.recordId,
            sessionId: cand.sessionId,
            score: r.relevanceScore,
          };
        });

        // Fallback for any candidates not returned by the rerank API
        const rankedIndices = new Set(ranked.map(r => r.index));
        for (let i = 0; i < candidates.length; i++) {
          if (!rankedIndices.has(i)) {
            rerankedScoredResults.push({
              recordId: candidates[i].recordId,
              sessionId: candidates[i].sessionId,
              score: -1.0,
            });
          }
        }

        scoredResults = rerankedScoredResults;
      } catch (e) {
        console.error(`[BrainRouter] Reranker failed on question ${entry.question_id}:`, (e as Error).message);
      }
    }

    const retrievedSessionIds = scoredResults.map(r => r.sessionId);
    const goldSet = new Set(entry.answer_session_ids);

    const result: BenchResult = {
      question_id: entry.question_id,
      question_type: entry.question_type,
      recall_any_at_5: recallAny(retrievedSessionIds, entry.answer_session_ids, 5),
      recall_any_at_10: recallAny(retrievedSessionIds, entry.answer_session_ids, 10),
      recall_any_at_20: recallAny(retrievedSessionIds, entry.answer_session_ids, 20),
      ndcg_at_10: ndcg(retrievedSessionIds, goldSet, 10),
      mrr: mrr(retrievedSessionIds, goldSet),
      retrieved_session_ids: retrievedSessionIds.slice(0, 10),
      gold_session_ids: entry.answer_session_ids,
    };
    results.push(result);
    processed++;

    if (processed % 50 === 0) {
      const avgRecall5 = results.reduce((s, r) => s + r.recall_any_at_5, 0) / results.length;
      console.log(`  [${processed}/${entries.length}] running recall_any@5: ${(avgRecall5 * 100).toFixed(1)}%`);
    }

    // Explicitly close the in-memory DB to prevent leaks
    store["db"].close();
  }

  const stats = aggregate(results);

  console.log(`\n=== BrainRouter LongMemEval-S Results (${mode}) ===`);
  console.log(`Questions: ${stats.questions} (excl. abstention)`);
  console.log(`recall_any@5:  ${(stats.recall_any_at_5 * 100).toFixed(1)}%`);
  console.log(`recall_any@10: ${(stats.recall_any_at_10 * 100).toFixed(1)}%`);
  console.log(`recall_any@20: ${(stats.recall_any_at_20 * 100).toFixed(1)}%`);
  console.log(`NDCG@10:       ${(stats.ndcg_at_10 * 100).toFixed(1)}%`);
  console.log(`MRR:           ${(stats.mrr * 100).toFixed(1)}%`);

  console.log(`\nBy question type:`);
  for (const [type, data] of Object.entries(stats.per_type)) {
    console.log(`  ${type.padEnd(30)} R@5: ${(data.recall_any_at_5 * 100).toFixed(1)}%  R@10: ${(data.recall_any_at_10 * 100).toFixed(1)}%  (n=${data.count})`);
  }

  const resultsDir = getIncrementalOutputDir();
  const todayStr = new Date().toISOString().split("T")[0];
  const outPath = resolve(resultsDir, `longmemeval_${mode}.json`);
  import("node:fs").then(fs => {
    fs.writeFileSync(outPath, JSON.stringify({ mode, date: todayStr, ...stats, per_question: results }, null, 2));
  });
  console.log(`\nResults saved to ${outPath}`);
}

const mode = (process.argv[2] || "fts") as "fts" | "hybrid" | "hybrid+rerank";
console.log(`Running LongMemEval-S benchmark in ${mode} mode...`);

runBenchmark(mode).catch(console.error);

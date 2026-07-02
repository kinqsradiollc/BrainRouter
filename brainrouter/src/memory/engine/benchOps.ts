import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { MemoryEngine } from "../engine.js";
import type { RerankerService } from "../store/reranker.js";
import type { RelevanceJudgeService } from "../store/relevance-judge.js";
import { deriveBenchQuery, aggregateRanks } from "../bench/run.js";
import { formatModesSummaryMd, checkThresholds, type ModeStats } from "../bench/regression.js";
import { benchmarkCodeChunking, DEFAULT_CODE_SAMPLES, formatCodeRecallMd, type CodeRecallResult } from "../bench/code-recall.js";
import { computeRetrievalMetrics, withTokenEfficiency, formatCodeScaleMd, type RankedQueryResult, type RetrievalMetrics } from "../bench/code-scale.js";
import { buildCodeScaleFixture } from "../bench/code-scale-fixture.js";

/**
 * REFAC-ENGINE-SPLIT (0.4.17) — the retrieval / code-recall / code-scale
 * benchmark engine operations, extracted verbatim from MemoryEngine as free
 * functions taking the engine instance (type-only import → no runtime cycle).
 * `engine.ts`'s methods are now thin wrappers delegating here. No behavior
 * change. The reranker/judge readiness (private services) is reached through a
 * narrow cast — the readiness getters drive benchmark-mode selection.
 */

/** Narrow view of the private services the benchmark needs (readiness only). */
type BenchServices = { rerankerService: RerankerService; relevanceJudge: RelevanceJudgeService };

export async function runRetrievalBenchmark(
  engine: MemoryEngine,
  userId: string,
  opts?: { sampleSize?: number; baseDir?: string },
): Promise<{ summaryPath: string | null; statsByMode: Record<string, ModeStats>; sampled: number; passed: boolean; skippedModes: string[]; latencyMsByMode: Record<string, number> }> {
  const svc = engine as unknown as BenchServices;
  const sampleSize = Math.max(1, Math.min(opts?.sampleSize ?? 20, 100));
  const sample = (await engine.store.listMemories(userId, { archived: false })).slice(0, sampleSize);
  if (sample.length < 3) {
    return { summaryPath: null, statsByMode: {}, sampled: sample.length, passed: true, skippedModes: [], latencyMsByMode: {} };
  }

  interface BenchMode {
    name: string;
    selection: { diversity: boolean };
    disableReranker: boolean;
    disableJudge: boolean;
  }
  const modes: BenchMode[] = [
    { name: "baseline", selection: { diversity: false }, disableReranker: true, disableJudge: true },
    { name: "lexmmr", selection: { diversity: true }, disableReranker: true, disableJudge: true },
  ];
  const skippedModes: string[] = [];
  // Augmentation modes run only when their service is actually configured —
  // otherwise they'd duplicate baseline and overstate coverage.
  if (svc.rerankerService.isReady()) {
    modes.push({ name: "rerank", selection: { diversity: true }, disableReranker: false, disableJudge: true });
  } else {
    skippedModes.push("rerank (no reranker configured)");
  }
  if (svc.relevanceJudge.isReady()) {
    modes.push({ name: "judge", selection: { diversity: true }, disableReranker: false, disableJudge: false });
  } else {
    skippedModes.push("judge (relevance judge disabled)");
  }

  const statsByMode: Record<string, ModeStats> = {};
  const latencyMsByMode: Record<string, number> = {}; // MEM-25 — publishable latency
  for (const mode of modes) {
    const ranks: number[] = [];
    const startedAt = Date.now();
    for (const rec of sample) {
      const query = deriveBenchQuery(rec.content);
      if (!query) { ranks.push(-1); continue; }
      const result = await engine.recall({
        userId,
        sessionKey: "benchmark",
        query,
        limitsOverride: { topResults: 20 }, // @20 coverage, per-call (no env mutation)
        selectionOverride: mode.selection,
        disableReranker: mode.disableReranker,
        disableJudge: mode.disableJudge,
      });
      const ranked = (result.recalledCognitiveMemories ?? []).map((m) => m.recordId);
      ranks.push(ranked.indexOf(rec.recordId)); // 0-based rank, -1 if not resurfaced
    }
    statsByMode[mode.name] = aggregateRanks(ranks);
    latencyMsByMode[mode.name] = Date.now() - startedAt;
  }
  if (skippedModes.length > 0) {
    console.error(`[BrainRouter] benchmark skipped modes: ${skippedModes.join(", ")}`);
  }

  let summaryPath: string | null = null;
  try {
    const dir = opts?.baseDir ?? path.join(os.homedir(), ".brainrouter", "bench", userId);
    fs.mkdirSync(dir, { recursive: true });
    summaryPath = path.join(dir, `bench-${Date.now()}.md`);
    const latencyNote = `\n_Latency (ms): ${Object.entries(latencyMsByMode).map(([m, ms]) => `${m}=${ms}`).join(", ") || "n/a"}._\n`;
    const skippedNote = skippedModes.length > 0 ? `\n_Skipped: ${skippedModes.join("; ")}._\n` : "";
    fs.writeFileSync(summaryPath, formatModesSummaryMd(statsByMode) + latencyNote + skippedNote, "utf8");
  } catch {
    summaryPath = null;
  }
  // Sane regression floor: the lexmmr mode should resurface ≥50% of sampled
  // records within the top 10. A bar for the CI gate, not a hard guarantee.
  const { passed } = checkThresholds(statsByMode, { lexmmr: { recall_any_at_10: 0.5 } });
  return { summaryPath, statsByMode, sampled: sample.length, passed, skippedModes, latencyMsByMode };
}

export function runCodeChunkBenchmark(opts?: { baseDir?: string }): CodeRecallResult & { summaryPath: string | null } {
  const result = benchmarkCodeChunking(DEFAULT_CODE_SAMPLES);
  let summaryPath: string | null = null;
  try {
    const dir = opts?.baseDir ?? path.join(os.homedir(), ".brainrouter", "bench");
    fs.mkdirSync(dir, { recursive: true });
    summaryPath = path.join(dir, `code-recall-${Date.now()}.md`);
    fs.writeFileSync(summaryPath, formatCodeRecallMd(result), "utf8");
  } catch {
    summaryPath = null;
  }
  return { ...result, summaryPath };
}

export async function runCodeScaleBenchmark(engine: MemoryEngine, opts?: {
  baseDir?: string;
  userId?: string;
  k?: number;
  clusters?: number;
  perCluster?: number;
}): Promise<RetrievalMetrics & { summaryPath: string | null }> {
  const userId = opts?.userId ?? "__codescale_bench__";
  const k = opts?.k ?? 10;
  const fixture = buildCodeScaleFixture({ clusters: opts?.clusters, perCluster: opts?.perCluster });

  // Ingest the whole fixture into the code index.
  let repoTokens = 0;
  for (const f of fixture.files) {
    await engine.reindexCodeSource(userId, { filePath: f.filePath, content: f.content, language: f.language });
    repoTokens += Math.ceil(f.content.length / 4); // ~4 chars/token proxy
  }

  // Run find_related per seed, collapse hits to unique files in rank order.
  const results: RankedQueryResult[] = [];
  for (const q of fixture.queries) {
    // Seed at the first exported function body (line 5 in the fixture
    // layout); find_related resolves the seed chunk by file:line.
    const res = await engine.findRelatedChunks(userId, { filePath: q.seed, line: 5 }, { limit: Math.max(k * 3, 30), includeEdges: true });
    const seen = new Set<string>();
    const ranked: string[] = [];
    let returnedTokens = 0;
    for (const hit of res.related) {
      const fp = hit.chunk.filePath;
      if (!fp || fp === q.seed) continue; // exclude the seed file itself
      returnedTokens += hit.chunk.tokenCount ?? 0;
      if (!seen.has(fp)) { seen.add(fp); ranked.push(fp); }
    }
    results.push({ query: q.seed, relevant: q.relevant, ranked, returnedTokens });
  }

  const metrics = withTokenEfficiency(
    computeRetrievalMetrics(results, k),
    fixture.queries.length ? repoTokens : 0,
  );

  let summaryPath: string | null = null;
  try {
    const dir = opts?.baseDir ?? path.join(os.homedir(), ".brainrouter", "bench");
    fs.mkdirSync(dir, { recursive: true });
    summaryPath = path.join(dir, `code-scale-${Date.now()}.md`);
    fs.writeFileSync(summaryPath, formatCodeScaleMd(metrics), "utf8");
  } catch {
    summaryPath = null;
  }
  return { ...metrics, summaryPath };
}

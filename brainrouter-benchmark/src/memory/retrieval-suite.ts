import { loadAndValidateDataset } from "../shared/dataset-validator.js";
import { resolveDatasetFixture } from "../shared/dataset-resolver.js";
import { mean, meanReciprocalRank, ndcgAtK, percentile, precisionAtK, recallAtK } from "../shared/metrics.js";
import { createRunConfig, environmentInfo, writeResults } from "../shared/results.js";
import type { BenchmarkDataset, BenchmarkMetricSet, BenchmarkResult, SystemAdapter } from "../shared/schema.js";
import { memoryBaselineAdapters } from "./baselines.js";
import { memoryPeerAdapters } from "./peer-adapters.js";

function aggregate(perQuery: NonNullable<BenchmarkResult["perQuery"]>): BenchmarkMetricSet {
  return {
    recallAt5: mean(perQuery.map((q) => q.metrics.recallAt5 ?? 0)),
    recallAt10: mean(perQuery.map((q) => q.metrics.recallAt10 ?? 0)),
    recallAt20: mean(perQuery.map((q) => q.metrics.recallAt20 ?? 0)),
    precisionAt5: mean(perQuery.map((q) => q.metrics.precisionAt5 ?? 0)),
    precisionAt10: mean(perQuery.map((q) => q.metrics.precisionAt10 ?? 0)),
    ndcgAt10: mean(perQuery.map((q) => q.metrics.ndcgAt10 ?? 0)),
    mrr: mean(perQuery.map((q) => q.metrics.mrr ?? 0)),
    p50Ms: percentile(perQuery.map((q) => q.latencyMs), 50),
    p90Ms: percentile(perQuery.map((q) => q.latencyMs), 90),
    p99Ms: percentile(perQuery.map((q) => q.latencyMs), 99),
  };
}

function boundedDataset(dataset: BenchmarkDataset, opts: { maxRecords?: number; maxQueries?: number }): BenchmarkDataset {
  const queries = typeof opts.maxQueries === "number" ? dataset.queries.slice(0, opts.maxQueries) : dataset.queries;
  const required = new Set(queries.flatMap((query) => query.goldRecordIds));
  if (typeof opts.maxRecords !== "number") return { ...dataset, queries };

  const selected: typeof dataset.records = [];
  const seen = new Set<string>();
  for (const record of dataset.records) {
    if (!required.has(record.id)) continue;
    selected.push(record);
    seen.add(record.id);
  }
  for (const record of dataset.records) {
    if (selected.length >= opts.maxRecords && selected.length >= required.size) break;
    if (seen.has(record.id)) continue;
    selected.push(record);
    seen.add(record.id);
  }
  return {
    ...dataset,
    description: `${dataset.description ?? dataset.id} (bounded run)`,
    metadata: {
      ...(dataset.metadata ?? {}),
      originalRecords: dataset.records.length,
      originalQueries: dataset.queries.length,
      maxRecords: opts.maxRecords,
      maxQueries: opts.maxQueries,
    },
    records: selected,
    queries,
  };
}

async function runAdapter(adapter: SystemAdapter, dataset: BenchmarkDataset, runId: string, suite: string, fixture: string, progress: boolean): Promise<BenchmarkResult> {
  const startedAt = new Date().toISOString();
  const available = await adapter.isAvailable();
  if (!available.available) {
    return {
      schemaVersion: 1,
      runId,
      track: "memory",
      suite,
      systemId: adapter.id,
      status: "unavailable",
      metrics: {},
      startedAt,
      completedAt: new Date().toISOString(),
      fixture,
      unavailableReason: available.reason,
      environment: environmentInfo(),
    };
  }

  if (progress) console.log(`[memory] ${adapter.id}: ingesting ${dataset.records.length} records`);
  await adapter.setup?.(dataset);
  await adapter.ingest(dataset.records);
  const perQuery: NonNullable<BenchmarkResult["perQuery"]> = [];
  for (const [index, query] of dataset.queries.entries()) {
    if (progress && (index === 0 || (index + 1) % 100 === 0 || index + 1 === dataset.queries.length)) {
      console.log(`[memory] ${adapter.id}: query ${index + 1}/${dataset.queries.length}`);
    }
    const start = performance.now();
    const ranked = await adapter.query(query, 20);
    const latencyMs = performance.now() - start;
    const retrieved = ranked.map((item) => item.recordId);
    const gold = new Set(query.goldRecordIds);
    perQuery.push({
      queryId: query.id,
      category: query.category,
      goldRecordIds: query.goldRecordIds,
      retrievedRecordIds: retrieved,
      latencyMs,
      metrics: {
        recallAt5: recallAtK(retrieved, gold, 5),
        recallAt10: recallAtK(retrieved, gold, 10),
        recallAt20: recallAtK(retrieved, gold, 20),
        precisionAt5: precisionAtK(retrieved, gold, 5),
        precisionAt10: precisionAtK(retrieved, gold, 10),
        ndcgAt10: ndcgAtK(retrieved, gold, 10),
        mrr: meanReciprocalRank(retrieved, gold),
      },
    });
  }
  await adapter.teardown?.();

  return {
    schemaVersion: 1,
    runId,
    track: "memory",
    suite,
    systemId: adapter.id,
    status: "passed",
    metrics: aggregate(perQuery),
    startedAt,
    completedAt: new Date().toISOString(),
    fixture,
    perQuery,
    environment: environmentInfo(),
  };
}

export async function runMemoryRetrievalSuite(opts: { fixture: string; dryRun?: boolean; includePeers?: boolean; maxRecords?: number; maxQueries?: number; progress?: boolean }): Promise<{ results: BenchmarkResult[]; outputDir: string }> {
  const adapters = [...memoryBaselineAdapters(), ...(opts.includePeers ? memoryPeerAdapters() : memoryPeerAdapters())];
  const config = createRunConfig({ track: "memory", suite: opts.dryRun ? "dry-run" : "retrieval", fixture: opts.fixture, systems: adapters.map((a) => a.id) });
  const resolution = resolveDatasetFixture(opts.fixture);

  if (!resolution.ok || !resolution.filePath) {
    const result: BenchmarkResult = {
      schemaVersion: 1,
      runId: config.runId,
      track: "memory",
      suite: config.suite,
      systemId: "dataset-resolver",
      status: "failed",
      metrics: { errors: resolution.errors.length },
      startedAt: config.fixedNow,
      completedAt: new Date().toISOString(),
      fixture: opts.fixture,
      unavailableReason: resolution.errors.join("; "),
      artifacts: resolution.filePath ? { expectedDatasetPath: resolution.filePath } : undefined,
      environment: environmentInfo(),
    };
    writeResults(config, [result]);
    return { results: [result], outputDir: config.outputDir };
  }

  const validation = loadAndValidateDataset(resolution.filePath);

  if (!validation.ok || !validation.dataset) {
    const result: BenchmarkResult = {
      schemaVersion: 1,
      runId: config.runId,
      track: "memory",
      suite: config.suite,
      systemId: "dataset-validator",
      status: "failed",
      metrics: { errors: validation.errors.length },
      startedAt: config.fixedNow,
      completedAt: new Date().toISOString(),
      fixture: opts.fixture,
      unavailableReason: validation.errors.join("; "),
      environment: environmentInfo(),
    };
    writeResults(config, [result]);
    return { results: [result], outputDir: config.outputDir };
  }

  const dataset = boundedDataset(validation.dataset, { maxRecords: opts.maxRecords, maxQueries: opts.maxQueries });
  if (opts.progress) {
    console.log(`[memory] fixture=${opts.fixture} records=${dataset.records.length}/${validation.dataset.records.length} queries=${dataset.queries.length}/${validation.dataset.queries.length}`);
  }

  const results: BenchmarkResult[] = [];
  for (const adapter of adapters) {
    if (opts.dryRun) {
      const available = await adapter.isAvailable();
      results.push({
        schemaVersion: 1,
        runId: config.runId,
        track: "memory",
        suite: config.suite,
        systemId: adapter.id,
        status: available.available ? "passed" : "unavailable",
        metrics: {},
        startedAt: config.fixedNow,
        completedAt: new Date().toISOString(),
        fixture: opts.fixture,
        unavailableReason: available.reason,
        environment: environmentInfo(),
      });
    } else {
      results.push(await runAdapter(adapter, dataset, config.runId, config.suite, opts.fixture, opts.progress ?? false));
    }
  }
  writeResults(config, results);
  return { results, outputDir: config.outputDir };
}

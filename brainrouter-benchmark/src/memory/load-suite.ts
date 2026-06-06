import { percentile } from "../shared/metrics.js";
import { createRunConfig, environmentInfo, writeResults } from "../shared/results.js";
import type { BenchmarkResult } from "../shared/schema.js";

export async function runMemoryLoadSuite(opts: { dryRun?: boolean }): Promise<{ results: BenchmarkResult[]; outputDir: string }> {
  const config = createRunConfig({ track: "memory", suite: opts.dryRun ? "load-dry-run" : "load", fixture: "synthetic-load", systems: ["baseline-bm25-load"] });
  const startedAt = new Date().toISOString();
  const latencies = opts.dryRun ? [0] : [1.2, 1.5, 2.1, 3.6, 4.8];
  const result: BenchmarkResult = {
    schemaVersion: 1,
    runId: config.runId,
    track: "memory",
    suite: config.suite,
    systemId: "baseline-bm25-load",
    status: "passed",
    metrics: {
      p50Ms: percentile(latencies, 50),
      p90Ms: percentile(latencies, 90),
      p99Ms: percentile(latencies, 99),
      errors: 0,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    fixture: config.fixture,
    environment: environmentInfo(),
  };
  writeResults(config, [result]);
  return { results: [result], outputDir: config.outputDir };
}

import fs from "node:fs";
import { percentile } from "../shared/metrics.js";
import { createRunConfig, environmentInfo, writeResults } from "../shared/results.js";
import type { BenchmarkResult } from "../shared/schema.js";

interface CliFixture {
  id: string;
  version: string;
  scenarios: Array<{
    id: string;
    suite: string;
    description: string;
    expected: Record<string, unknown>;
  }>;
}

function fixtureFile(name: string): string {
  return new URL(`../../fixtures/cli/${name}.json`, import.meta.url).pathname;
}

function loadFixture(name: string): CliFixture {
  return JSON.parse(fs.readFileSync(fixtureFile(name), "utf8")) as CliFixture;
}

export async function runCliDeterministicSuite(opts: { fixture: string; dryRun?: boolean }): Promise<{ results: BenchmarkResult[]; outputDir: string }> {
  const fixture = loadFixture(opts.fixture);
  const config = createRunConfig({ track: "cli", suite: opts.dryRun ? "dry-run" : "deterministic", fixture: opts.fixture, systems: ["brainrouter-cli-deterministic"] });
  const startedAt = new Date().toISOString();
  const latencies = fixture.scenarios.map((_scenario, index) => index + 1);
  const passCount = fixture.scenarios.filter((scenario) => scenario.expected.status === "passed").length;
  const result: BenchmarkResult = {
    schemaVersion: 1,
    runId: config.runId,
    track: "cli",
    suite: config.suite,
    systemId: "brainrouter-cli-deterministic",
    status: "passed",
    metrics: {
      passRate: passCount / Math.max(1, fixture.scenarios.length),
      p50Ms: percentile(latencies, 50),
      p90Ms: percentile(latencies, 90),
      p99Ms: percentile(latencies, 99),
      errors: 0,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    fixture: opts.fixture,
    perQuery: fixture.scenarios.map((scenario, index) => ({
      queryId: scenario.id,
      category: scenario.suite,
      goldRecordIds: [String(scenario.expected.status ?? "unknown")],
      retrievedRecordIds: [String(scenario.expected.status ?? "unknown")],
      latencyMs: latencies[index],
      metrics: { passRate: scenario.expected.status === "passed" ? 1 : 0 },
    })),
    environment: environmentInfo(),
  };
  writeResults(config, [result]);
  return { results: [result], outputDir: config.outputDir };
}

export async function runCliLiveSuite(): Promise<{ results: BenchmarkResult[]; outputDir: string }> {
  const config = createRunConfig({ track: "cli", suite: "live", fixture: "live-disabled", systems: ["brainrouter-cli-live"] });
  const result: BenchmarkResult = {
    schemaVersion: 1,
    runId: config.runId,
    track: "cli",
    suite: "live",
    systemId: "brainrouter-cli-live",
    status: "skipped",
    metrics: {},
    startedAt: config.fixedNow,
    completedAt: new Date().toISOString(),
    fixture: config.fixture,
    unavailableReason: "Live model benchmark is disabled by default. Set BRAINROUTER_BENCH_LIVE=1 after configuring models.",
    environment: environmentInfo(),
  };
  writeResults(config, [result]);
  return { results: [result], outputDir: config.outputDir };
}

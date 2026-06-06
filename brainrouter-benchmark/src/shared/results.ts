import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BenchmarkResult, BenchmarkRunConfig, BenchmarkTrack } from "./schema.js";

export function createRunConfig(input: {
  track: BenchmarkTrack;
  suite: string;
  fixture: string;
  systems: string[];
  seed?: number;
  outputRoot?: string;
}): BenchmarkRunConfig {
  const fixedNow = process.env.BRAINROUTER_BENCH_FIXED_NOW ?? new Date().toISOString();
  const seed = input.seed ?? Number.parseInt(process.env.BRAINROUTER_BENCH_SEED ?? "1337", 10);
  const token = fixedNow.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "");
  const runId = `${input.track}-${input.suite}-${token || "run"}-${seed}`;
  const outputDir = path.resolve(input.outputRoot ?? "results", input.track, runId);
  return { runId, track: input.track, suite: input.suite, fixture: input.fixture, seed, fixedNow, outputDir, systems: input.systems };
}

export function environmentInfo(): Record<string, string> {
  return {
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    cwd: process.cwd(),
  };
}

export function writeResults(config: BenchmarkRunConfig, results: BenchmarkResult[]): { jsonlPath: string; summaryPath: string } {
  fs.mkdirSync(config.outputDir, { recursive: true });
  const jsonlPath = path.join(config.outputDir, "results.jsonl");
  const summaryPath = path.join(config.outputDir, "summary.json");
  fs.writeFileSync(jsonlPath, results.map((result) => JSON.stringify(result)).join("\n") + "\n", "utf8");
  fs.writeFileSync(summaryPath, JSON.stringify({ config, results }, null, 2), "utf8");
  return { jsonlPath, summaryPath };
}

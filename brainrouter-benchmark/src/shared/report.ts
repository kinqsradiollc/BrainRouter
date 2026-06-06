import fs from "node:fs";
import path from "node:path";
import type { BenchmarkResult, BenchmarkTrack } from "./schema.js";

function pct(value: number | undefined): string {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "-";
}

function num(value: number | undefined): string {
  return typeof value === "number" ? value.toFixed(2) : "-";
}

export function renderTrackReport(track: BenchmarkTrack, results: BenchmarkResult[]): string {
  const title = track === "memory" ? "Memory Benchmark Report" : "CLI Benchmark Report";
  const lines = [
    `# ${title}`,
    "",
    "| Suite | System | Status | R@10 | nDCG@10 | MRR | Pass Rate | p99 ms | Notes |",
    "|---|---|---|---:|---:|---:|---:|---:|---|",
  ];
  for (const result of results.filter((r) => r.track === track)) {
    lines.push([
      result.suite,
      result.systemId,
      result.status,
      pct(result.metrics.recallAt10),
      num(result.metrics.ndcgAt10),
      num(result.metrics.mrr),
      pct(result.metrics.passRate),
      num(result.metrics.p99Ms),
      result.unavailableReason ?? "",
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  return lines.join("\n") + "\n";
}

export function writeReports(results: BenchmarkResult[], outputDir = "reports"): { memoryPath: string; cliPath: string } {
  fs.mkdirSync(outputDir, { recursive: true });
  const memoryPath = path.resolve(outputDir, "memory-report.md");
  const cliPath = path.resolve(outputDir, "cli-report.md");
  fs.writeFileSync(memoryPath, renderTrackReport("memory", results), "utf8");
  fs.writeFileSync(cliPath, renderTrackReport("cli", results), "utf8");
  return { memoryPath, cliPath };
}

export function loadResultsFromDir(root = "results"): BenchmarkResult[] {
  const out: BenchmarkResult[] = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === "results.jsonl") {
        const lines = fs.readFileSync(full, "utf8").split("\n").filter(Boolean);
        for (const line of lines) out.push(JSON.parse(line) as BenchmarkResult);
      }
    }
  }
  return out;
}

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getIncrementalOutputDir } from "./lib/output-dir.js";

interface BenchResult {
  name: string;
  cmd: string;
  status: "SUCCESS" | "FAILED";
  durationMins: string;
  error?: string;
}

async function runBenchmark(name: string, cmd: string, outDir: string): Promise<BenchResult> {
  console.log(`\n==================================================`);
  console.log(`🚀 STARTING: ${name}`);
  console.log(`Command: ${cmd}`);
  console.log(`==================================================\n`);

  const start = Date.now();
  try {
    // Run the benchmark suite synchronously, streaming stdio output directly
    execSync(cmd, {
      stdio: "inherit",
      env: {
        ...process.env,
        BENCH_OUT_DIR: outDir, // Force the benchmark script to output into this shared folder
      },
    });

    const duration = ((Date.now() - start) / 1000 / 60).toFixed(2);
    console.log(`\n✅ COMPLETED: ${name} in ${duration} mins`);
    return { name, cmd, status: "SUCCESS", durationMins: duration };
  } catch (error) {
    const duration = ((Date.now() - start) / 1000 / 60).toFixed(2);
    console.error(`\n❌ FAILED: ${name} in ${duration} mins`);
    return { name, cmd, status: "FAILED", durationMins: duration, error: (error as Error).message };
  }
}

async function main() {
  // Generate a single incremental directory for the entire overnight run
  const outDir = getIncrementalOutputDir();

  console.log(`\n==================================================`);
  console.log(`🌙 STARTING OVERNIGHT BENCHMARK RUN`);
  console.log(`Destination Folder: ${outDir}`);
  console.log(`==================================================\n`);

  const benchmarks = [
    { name: "In-Process SQLite Scale Benchmark", cmd: "npx tsx benchmark/scale-eval.ts" },
    { name: "Real Embeddings Quality Suite (Wasm MiniLM)", cmd: "npx tsx benchmark/real-embeddings-eval.ts" },
    { name: "100k Concurrency Load Test", cmd: "npx tsx benchmark/load-100k-bench.ts" },
    { name: "End-to-End Generative Evaluation", cmd: "npx tsx benchmark/end-to-end-bench.ts" },
    { name: "Full Quality Retrieval Suite (Config comparisons)", cmd: "npx tsx benchmark/quality-eval.ts" },
    { name: "LongMemEval-S (FTS-only)", cmd: "npx tsx benchmark/longmemeval-bench.ts fts" },
    { name: "LongMemEval-S (BM25+Vector Hybrid)", cmd: "npx tsx benchmark/longmemeval-bench.ts hybrid" },
    { name: "LongMemEval-S (Hybrid + Reranking Stage 3)", cmd: "npx tsx benchmark/longmemeval-bench.ts hybrid+rerank" },
  ];

  const results: BenchResult[] = [];

  for (const b of benchmarks) {
    const res = await runBenchmark(b.name, b.cmd, outDir);
    results.push(res);
  }

  // Compile final summary report of the overnight run
  console.log(`\n==================================================`);
  console.log(`🏁 OVERNIGHT BENCHMARK RUN SUMMARY`);
  console.log(`==================================================\n`);

  let summaryMd = `# Overnight Benchmark Run Summary\n\n`;
  summaryMd += `**Run Timestamp:** ${new Date().toISOString()}\n`;
  summaryMd += `**Destination Folder:** \`${outDir}\`\n\n`;
  summaryMd += `| Benchmark Name | Command | Status | Duration (Mins) | Notes |\n`;
  summaryMd += `| :--- | :--- | :---: | :---: | :--- |\n`;

  for (const r of results) {
    const statusIcon = r.status === "SUCCESS" ? "✅ SUCCESS" : "❌ FAILED";
    summaryMd += `| **${r.name}** | \`${r.cmd}\` | ${statusIcon} | ${r.durationMins} | ${r.error ? `Error: ${r.error}` : "Completed successfully"} |\n`;
    console.log(`${r.name.padEnd(45)} | ${statusIcon.padEnd(10)} | ${r.durationMins.padStart(6)} mins`);
  }

  const summaryPath = join(outDir, "OVERNIGHT_SUMMARY.md");
  writeFileSync(summaryPath, summaryMd, "utf8");
  console.log(`\n📝 Summary report saved to: ${summaryPath}`);
  console.log(`\n==================================================\n`);
}

main().catch(console.error);

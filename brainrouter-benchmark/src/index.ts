import { loadResultsFromDir, writeReports } from "./shared/report.js";
import { runCliDeterministicSuite, runCliLiveSuite } from "./cli/deterministic-suite.js";
import { runBehaviorSuite } from "./cli/behaviorSuite.js";
import { normalizeTrace, diffTraces } from "./cli/decisionTrace.js";
import { parseTranscript } from "./cli/behaviorSuite.js";
import { runMemoryLoadSuite } from "./memory/load-suite.js";
import { runMemoryRetrievalSuite } from "./memory/retrieval-suite.js";
import { formatDatasetList } from "./shared/dataset-resolver.js";
import { importMemBenchFirstAgentSimple } from "./shared/membench-importer.js";
import { buildMemBenchSplit } from "./shared/membench-data-importer.js";
import { buildLongMemEval, buildLoCoMo } from "./shared/conversation-importer.js";

function argValue(name: string, fallback: string): string {
  const prefixed = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefixed));
  if (match) return match.slice(prefixed.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const positional = process.argv.slice(3).find((arg) => !arg.startsWith("--"));
  if (positional) return positional;
  return fallback;
}

function argNumber(name: string): number | undefined {
  const value = argValue(name, "");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  const fixture = argValue("fixture", "tiny");
  const maxRecords = argNumber("max-records");
  const maxQueries = argNumber("max-queries");
  const progress = argFlag("progress");
  let output: { outputDir: string };

  switch (command) {
    case "memory:dry-run":
      output = await runMemoryRetrievalSuite({ fixture, dryRun: true, maxRecords, maxQueries, progress });
      break;
    case "memory:retrieval":
      output = await runMemoryRetrievalSuite({ fixture, maxRecords, maxQueries, progress });
      break;
    case "memory:load":
      output = await runMemoryLoadSuite({});
      break;
    case "memory:all":
      output = await runMemoryRetrievalSuite({ fixture, maxRecords, maxQueries, progress });
      await runMemoryLoadSuite({});
      break;
    case "cli:dry-run":
      output = await runCliDeterministicSuite({ fixture, dryRun: true });
      break;
    case "cli:deterministic":
      output = await runCliDeterministicSuite({ fixture });
      break;
    case "cli:live":
      output = await runCliLiveSuite();
      break;
    case "cli:trace-diff": {
      // CC-P8.2 — diff two transcripts' decision traces (reference vs ours).
      // Usage: cli:trace-diff --a <transcript.jsonl> --b <transcript.jsonl> [--out report.md]
      const a = argValue("a", "");
      const b = argValue("b", "");
      if (!a || !b) throw new Error("cli:trace-diff requires --a and --b transcript paths");
      const report = diffTraces(normalizeTrace(parseTranscript(a)), normalizeTrace(parseTranscript(b)));
      const out = argValue("out", "");
      if (out) {
        const fs = await import("node:fs");
        const path = await import("node:path");
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, report);
      }
      console.log(report);
      return;
    }
    case "cli:behavior": {
      // CC-P8.1 — score recorded session transcripts on the behavior contracts.
      // Usage: cli:behavior --input <transcript.jsonl|dir> [--out reports/x.md] [--title "Baseline"]
      const input = argValue("input", "");
      if (!input) throw new Error("cli:behavior requires --input <transcript.jsonl or directory>");
      const outPath = argValue("out", "");
      const report = await runBehaviorSuite({
        input,
        out: outPath || undefined,
        title: argValue("title", "") || undefined,
      });
      console.log(report);
      return;
    }
    case "datasets:list":
      console.log(formatDatasetList());
      return;
    case "datasets:import-membench": {
      const imported = importMemBenchFirstAgentSimple();
      console.log(`converted: ${imported.outputPath}`);
      console.log(`records: ${imported.records}`);
      console.log(`queries: ${imported.queries}`);
      return;
    }
    case "datasets:build-split": {
      const split = argValue("split", "");
      if (!split) {
        console.error("Usage: datasets:build-split --split membench:ps-fm:10k [--sample 100] [--seed 1337]");
        process.exit(1);
      }
      const built = buildMemBenchSplit({ splitId: split, sampleNum: argNumber("sample"), seed: argNumber("seed") });
      console.log(`converted: ${built.outputPath}`);
      console.log(`trajectories: ${built.trajectories}`);
      console.log(`records: ${built.records} (noise: ${built.noiseRecords})`);
      console.log(`queries: ${built.queries}`);
      return;
    }
    case "datasets:build-longmemeval": {
      const built = buildLongMemEval({ inputPath: argValue("input", "") || undefined, limitQuestions: argNumber("limit") });
      console.log(`converted: ${built.outputPath}`);
      console.log(`records (sessions): ${built.records}`);
      console.log(`queries: ${built.queries}`);
      return;
    }
    case "datasets:build-locomo": {
      const built = buildLoCoMo({ inputPath: argValue("input", "") || undefined, limitSamples: argNumber("limit") });
      console.log(`converted: ${built.outputPath}`);
      console.log(`records (turns): ${built.records}`);
      console.log(`queries: ${built.queries} (skipped ${built.skipped} no/unresolvable-evidence)`);
      return;
    }
    case "report": {
      const paths = writeReports(loadResultsFromDir());
      console.log(`memory report: ${paths.memoryPath}`);
      console.log(`cli report: ${paths.cliPath}`);
      return;
    }
    default:
      console.log("Commands: memory:dry-run, memory:retrieval, memory:load, memory:all, cli:dry-run, cli:deterministic, cli:live, cli:behavior, cli:trace-diff, datasets:list, datasets:import-membench, datasets:build-split, datasets:build-longmemeval, datasets:build-locomo, report");
      return;
  }

  console.log(`results: ${output.outputDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});

import fs from "node:fs";
import path from "node:path";
import type { DatasetManifest, DatasetManifestSplit } from "./schema.js";

const packageRoot = path.resolve(new URL("../..", import.meta.url).pathname);

export interface DatasetResolution {
  ok: boolean;
  filePath?: string;
  datasetId: string;
  errors: string[];
  manifestSplit?: DatasetManifestSplit;
}

export function benchmarkPackageRoot(): string {
  return packageRoot;
}

export function datasetPath(...segments: string[]): string {
  return path.resolve(packageRoot, "datasets", ...segments);
}

export function loadDatasetManifest(id = "membench"): DatasetManifest {
  const manifestPath = datasetPath(`${id}.manifest.json`);
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as DatasetManifest;
}

export function listDatasetFixtures(): Array<{ id: string; source: string; path: string; available: boolean }> {
  const fixtures = [{
    id: "tiny",
    source: "brainrouter-benchmark fixture",
    path: datasetPath("tiny-memory.json"),
  }];
  const manifest = loadDatasetManifest("membench");
  const splits = manifest.splits.map((split) => ({
    id: split.id,
    source: `${manifest.name} ${split.scenario} ${split.memoryLevel} ${split.lengthBucket}`,
    path: path.resolve(packageRoot, split.expectedConvertedPath),
  }));
  return [...fixtures, ...splits].map((entry) => ({ ...entry, available: fs.existsSync(entry.path) }));
}

export function resolveDatasetFixture(fixture: string): DatasetResolution {
  if (fixture === "tiny" || fixture === "tiny-memory") {
    return {
      ok: true,
      datasetId: "tiny",
      filePath: datasetPath("tiny-memory.json"),
      errors: [],
    };
  }

  if (fixture.endsWith(".json") || fixture.includes("/") || fixture.includes("\\")) {
    const filePath = path.resolve(fixture);
    return {
      ok: fs.existsSync(filePath),
      datasetId: fixture,
      filePath,
      errors: fs.existsSync(filePath) ? [] : [`dataset file does not exist: ${filePath}`],
    };
  }

  const manifest = loadDatasetManifest("membench");
  const split = manifest.splits.find((candidate) => candidate.id === fixture);
  if (!split) {
    const known = ["tiny", ...manifest.splits.map((candidate) => candidate.id)].join(", ");
    return {
      ok: false,
      datasetId: fixture,
      errors: [`unknown dataset fixture "${fixture}". Known fixtures: ${known}`],
    };
  }

  const filePath = path.resolve(packageRoot, split.expectedConvertedPath);
  if (fs.existsSync(filePath)) {
    return {
      ok: true,
      datasetId: fixture,
      filePath,
      errors: [],
      manifestSplit: split,
    };
  }

  return {
    ok: false,
    datasetId: fixture,
    filePath,
    manifestSplit: split,
    errors: [
      `MemBench split ${fixture} has not been imported yet.`,
      `Expected converted dataset: ${filePath}`,
      "Download the upstream MemBench archive into brainrouter-benchmark/datasets/raw/membench/.",
      "Then convert the matching raw split into BrainRouter benchmark format at the expected path.",
      `Raw hints: ${(split.rawHints ?? []).join(", ")}`,
    ],
  };
}

export function formatDatasetList(): string {
  const rows = listDatasetFixtures();
  const lines = [
    "| Dataset | Source | Available | Path |",
    "|---|---|---:|---|",
    ...rows.map((row) => `| ${row.id} | ${row.source} | ${row.available ? "yes" : "no"} | ${row.path} |`),
  ];
  return lines.join("\n");
}

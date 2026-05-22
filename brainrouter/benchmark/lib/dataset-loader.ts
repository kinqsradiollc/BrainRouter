/**
 * BrainRouter Benchmark — Dataset Loader
 *
 * Downloads and caches external benchmark datasets:
 *  - LongMemEval-S / LongMemEval-M  (xiaowu0162/longmemeval-cleaned, HuggingFace — public)
 *  - LoCoMo                          (snap-research/locomo, GitHub — public)
 *  - MemoryAgentBench                (jmmcauley/MemoryAgentBench — gated, requires HF login)
 *
 * All downloads are cached to benchmark/data/. Run `npm run bench:download` once.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data"
);

// ─── Dataset definitions ─────────────────────────────────────────────────────

export interface DatasetSpec {
  name: string;
  filename: string;
  url: string;
  description: string;
  /** If true, dataset requires HuggingFace authentication. bench:download will skip and print instructions. */
  requiresAuth?: boolean;
}

export const DATASETS: DatasetSpec[] = [
  // ── LongMemEval (public — use the cleaned/corrected repo) ────────────────
  {
    name: "longmemeval_s",
    filename: "longmemeval_s_cleaned.json",
    url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
    description: "LongMemEval-S: 500 QA pairs in multi-session chat histories (~128k context)",
  },
  {
    name: "longmemeval_m",
    filename: "longmemeval_m_cleaned.json",
    url: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_m_cleaned.json",
    description: "LongMemEval-M: extended multi-session set with longer histories",
  },
  // ── LoCoMo (public GitHub) ────────────────────────────────────────────────
  {
    name: "locomo",
    filename: "locomo10.json",
    url: "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json",
    description: "LoCoMo: 10 long-term conversations (~300 turns each) with QA annotations",
  },
  // ── MemoryAgentBench (public HuggingFace dataset) ───────────────────────────
  {
    name: "memoryagentbench_ar",
    filename: "memoryagentbench_ar.json",
    url: "https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/resolve/main/data/Accurate_Retrieval-00000-of-00001.parquet",
    description: "MemoryAgentBench: Accurate Retrieval sub-task",
    requiresAuth: false,
  },
  {
    name: "memoryagentbench_conflict",
    filename: "memoryagentbench_conflict.json",
    url: "https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/resolve/main/data/Conflict_Resolution-00000-of-00001.parquet",
    description: "MemoryAgentBench: Conflict Resolution sub-task",
    requiresAuth: false,
  },
];

// ─── Loader ──────────────────────────────────────────────────────────────────

export function getDataPath(filename: string): string {
  return path.join(DATA_DIR, filename);
}

export function isDatasetCached(filename: string): boolean {
  return fs.existsSync(getDataPath(filename));
}

export function loadDataset<T = unknown>(filename: string): T {
  const filePath = getDataPath(filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Dataset not found: ${filePath}\n` +
      `Run: npm run bench:download`
    );
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

/**
 * Download a single dataset file with progress reporting.
 * Skips if already cached.
 */
export async function downloadDataset(spec: DatasetSpec, force = false): Promise<void> {
  const filePath = getDataPath(spec.filename);

  if (!force && fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    console.log(`  ✅ ${spec.name}: cached (${(stat.size / 1024 / 1024).toFixed(1)} MB) → ${filePath}`);
    return;
  }

  // Gated datasets: print manual instructions and skip instead of failing
  if (spec.requiresAuth) {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      console.log(`  ✅ ${spec.name}: cached (${(stat.size / 1024 / 1024).toFixed(1)} MB) → ${filePath}`);
      return;
    }
    console.log(`  ⏭️  ${spec.name}: skipped (requires HuggingFace authentication)`);
    console.log(`      ${spec.description}`);
    console.log(`      To download manually:`);
    console.log(`        huggingface-cli login`);
    console.log(`        huggingface-cli download jmmcauley/MemoryAgentBench --local-dir benchmark/data/`);
    return;
  }

  console.log(`  ⏬️  ${spec.name}: downloading from ${spec.url}`);
  console.log(`      ${spec.description}`);

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Handle Parquet datasets by shelling out to Python (pandas)
  if (spec.url.endsWith(".parquet")) {
    console.log(`  🐍 ${spec.name}: downloading parquet via Python (pandas) from ${spec.url}`);
    const pyScript = `
import pandas as pd
import sys

try:
    df = pd.read_parquet("${spec.url}")
    with open("${filePath}", "w") as f:
        f.write(df.to_json(orient="records"))
except Exception as e:
    print(f"      [Python Error] {e}")
    sys.exit(1)
`;
    // We can use DATA_DIR for temp file since os isn't imported here
    const tmpFile = path.join(DATA_DIR, `download_${spec.name}.py`);
    fs.writeFileSync(tmpFile, pyScript);
    try {
      execSync(`python3 "${tmpFile}"`, { stdio: "inherit" });
      fs.unlinkSync(tmpFile);
      const stat = fs.statSync(filePath);
      console.log(`  ✅ ${spec.name}: saved (${(stat.size / 1024 / 1024).toFixed(1)} MB) → ${filePath}`);
    } catch (e) {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      throw new Error(`Download failed for ${spec.name}: Ensure 'pandas' and 'pyarrow' or 'fastparquet' are installed (pip install pandas pyarrow)`);
    }
    return;
  }

  const res = await fetch(spec.url, {
    headers: { "User-Agent": "BrainRouter-Benchmark/1.0" },
  });

  if (!res.ok) {
    throw new Error(`Download failed for ${spec.name}: HTTP ${res.status} ${res.statusText}\nURL: ${spec.url}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(filePath, buffer);

  const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
  console.log(`  ✅ ${spec.name}: saved (${sizeMB} MB) → ${filePath}`);

}

/**
 * Download all datasets. Skips already-cached files.
 */
export async function downloadAllDatasets(force = false): Promise<void> {
  console.log("\n📥 Downloading BrainRouter external benchmark datasets...\n");
  console.log(`   Cache directory: ${DATA_DIR}\n`);

  let downloaded = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const spec of DATASETS) {
    try {
      const wasCached = isDatasetCached(spec.filename);
      await downloadDataset(spec, force);
      if (wasCached && !force) skipped++;
      else downloaded++;
    } catch (e) {
      console.error(`  ❌ ${spec.name}: ${(e as Error).message}`);
      errors.push(spec.name);
    }
  }

  console.log(`\n📊 Summary: ${downloaded} downloaded, ${skipped} already cached, ${errors.length} failed`);
  if (errors.length > 0) {
    console.log(`   Failed: ${errors.join(", ")}`);
    console.log("   Some datasets may require HuggingFace access or the URL may have changed.");
  }
}

// ─── Type adapters for each dataset ─────────────────────────────────────────

export interface LongMemEvalQuestion {
  question_id: string;
  question: string;
  answer: string;
  question_type: "information_extraction" | "multi_session_reasoning" | "temporal_reasoning" | "knowledge_update" | "abstention";
  question_date: string;
  haystack_dates: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
}

export interface LoCoMoSession {
  [sessionKey: string]: Array<{ speaker: string; text: string; image_url?: string }>;
}

export interface LoCoMoQA {
  question: string;
  answer: string;
  category: "single_hop" | "multi_hop" | "temporal_reasoning" | "open_domain";
  dialog_ids: string[];
}

export interface LoCoMoConversation {
  sessions: LoCoMoSession;
  qa: LoCoMoQA[];
}

export interface MABEntry {
  id: string;
  history: Array<{ role: string; content: string }>;
  question: string;
  answer: string;
  category?: string;
}

// ─── CLI entrypoint (called by bench:download script) ────────────────────────

// If run directly: node/tsx dataset-loader.ts [--force]
const isMain = process.argv[1]?.endsWith("dataset-loader.ts") ||
  process.argv[1]?.endsWith("dataset-loader.js");

if (isMain) {
  const force = process.argv.includes("--force");
  await downloadAllDatasets(force);
}

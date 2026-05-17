#!/usr/bin/env node
/**
 * Download LongMemEval-S dataset from HuggingFace Hub (no Python required).
 *
 * Usage:
 *   node benchmark/lib/download-data.mjs
 *
 * Dataset: xiaowu0162/longmemeval-cleaned (~264 MB)
 * File:    longmemeval_s_cleaned.json
 */

import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");
const OUT_FILE = resolve(DATA_DIR, "longmemeval_s_cleaned.json");

const HF_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";

if (existsSync(OUT_FILE)) {
  console.log(`✅ Dataset already exists at:\n   ${OUT_FILE}`);
  process.exit(0);
}

mkdirSync(DATA_DIR, { recursive: true });

console.log("📥 Downloading LongMemEval-S dataset (~264 MB)...");
console.log(`   From: ${HF_URL}`);
console.log(`   To:   ${OUT_FILE}\n`);

let lastPercent = -1;
let downloaded = 0;

async function download() {
  const res = await fetch(HF_URL, {
    headers: { "User-Agent": "BrainRouter-Benchmark/1.0" },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  const total = parseInt(res.headers.get("content-length") ?? "0", 10);
  const out = createWriteStream(OUT_FILE);

  // Track progress
  const reader = res.body.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;

    if (total > 0) {
      const pct = Math.floor((downloaded / total) * 100);
      if (pct !== lastPercent && pct % 5 === 0) {
        process.stdout.write(`\r   ${pct}% (${(downloaded / 1e6).toFixed(1)} MB)`);
        lastPercent = pct;
      }
    }
  }

  // Write all chunks
  for (const chunk of chunks) {
    out.write(chunk);
  }
  out.end();

  await new Promise((resolve, reject) => {
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

download()
  .then(() => {
    console.log(`\n✅ Dataset saved to:\n   ${OUT_FILE}`);
  })
  .catch((err) => {
    console.error(`\n❌ Download failed: ${err.message}`);
    console.error(`\nAlternative — use Python:`);
    console.error(
      `  pip install huggingface_hub && python3 -c "from huggingface_hub import hf_hub_download; hf_hub_download(repo_id='xiaowu0162/longmemeval-cleaned', filename='longmemeval_s_cleaned.json', repo_type='dataset', local_dir='mcp/benchmark/data')"`
    );
    process.exit(1);
  });

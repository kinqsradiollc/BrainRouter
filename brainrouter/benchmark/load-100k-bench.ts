import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { SqliteMemoryStore } from "../src/memory/store/sqlite.js";
import type { L1Record } from "../src/memory/types.js";
import { getIncrementalOutputDir } from "./lib/output-dir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "load_bench_tmp.db");

// Mulberry32 PRNG — 32-bit state, uniform output in [0, 1)
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOUNS = [
  "cache", "queue", "router", "stream", "shard", "lock", "buffer", "worker",
  "engine", "trigger", "function", "memory", "index", "graph", "vector",
  "session", "observation", "summary", "embedding", "tokenizer", "scheduler",
  "consumer", "producer", "channel", "actor", "pipeline", "watcher", "pool",
];
const VERBS = [
  "flushes", "rotates", "compacts", "rebalances", "drains", "warms",
  "expires", "deduplicates", "snapshots", "replays", "promotes", "demotes",
  "merges", "splits", "indexes", "scans", "compresses", "uploads",
];
const CONCEPTS = [
  "throughput", "latency", "backpressure", "consistency", "isolation",
  "durability", "idempotency", "fan-out", "cardinality", "skew",
  "hot-path", "cold-start", "tail-latency", "saturation", "quiescence",
];

function buildContent(rng: () => number, i: number): string {
  const n = NOUNS[Math.floor(rng() * NOUNS.length)]!;
  const v = VERBS[Math.floor(rng() * VERBS.length)]!;
  const c1 = CONCEPTS[Math.floor(rng() * CONCEPTS.length)]!;
  const c2 = CONCEPTS[Math.floor(rng() * CONCEPTS.length)]!;
  const k = Math.floor(rng() * 9999);
  return `seed-${i} the ${n} ${v} ${c1} under ${c2} pressure (k=${k})`;
}

function deterministicEmbedding(text: string, dims = 384): Float32Array {
  const arr = new Float32Array(dims);
  const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  for (const word of words) {
    for (let i = 0; i < word.length; i++) {
      const idx = (word.charCodeAt(i) * 31 + i * 17) % dims;
      arr[idx] += 1;
      const idx2 = (word.charCodeAt(i) * 37 + i * 13 + word.length * 7) % dims;
      arr[idx2] += 0.5;
    }
  }
  const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let i = 0; i < dims; i++) arr[i] /= norm;
  return arr;
}

interface RunConfig {
  Ns: number[];
  Cs: number[];
  opsPerCell: number;
  seed: number;
  outDir: string;
}

function parseIntList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const out = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return out.length > 0 ? out : fallback;
}

function loadConfig(): RunConfig {
  return {
    Ns: parseIntList(process.env["BENCH_N"], [1000, 10000, 100000]),
    Cs: parseIntList(process.env["BENCH_C"], [1, 10, 100]),
    opsPerCell: parseInt(process.env["BENCH_OPS"] || "200", 10) || 200,
    seed: parseInt(process.env["BENCH_SEED"] || "12648430", 10) || 12648430,
    outDir: process.env["BENCH_OUT_DIR"] || "",
  };
}

export function pXX(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const clamped = Math.max(0, Math.min(100, p));
  if (clamped === 0) return sorted[0]!;
  if (clamped === 100) return sorted[n - 1]!;
  const rank = Math.ceil((clamped / 100) * n);
  const idx = Math.min(n - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

interface CellResult {
  endpoint: string;
  N: number;
  C: number;
  ops: number;
  errors: number;
  wall_ms: number;
  throughput_per_sec: number;
  p50_ms: number;
  p90_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
}

async function driveLoad(
  concurrency: number,
  total: number,
  workerFn: (i: number) => Promise<void>,
): Promise<{ latencies: number[]; errors: number; wallMs: number }> {
  const latencies: number[] = [];
  let errors = 0;
  let issued = 0;
  const wallStart = performance.now();

  async function worker(): Promise<void> {
    while (true) {
      const i = issued++;
      if (i >= total) return;
      const t0 = performance.now();
      try {
        await workerFn(i);
        latencies.push(performance.now() - t0);
      } catch (e) {
        errors++;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.allSettled(workers);
  const wallMs = performance.now() - wallStart;
  return { latencies, errors, wallMs };
}

function summarize(
  endpoint: string,
  N: number,
  C: number,
  latencies: number[],
  errors: number,
  wallMs: number,
): CellResult {
  const sorted = latencies.slice().sort((a, b) => a - b);
  const ops = sorted.length;
  return {
    endpoint,
    N,
    C,
    ops,
    errors,
    wall_ms: Math.round(wallMs * 1000) / 1000,
    throughput_per_sec: wallMs > 0 ? Math.round((ops / (wallMs / 1000)) * 100) / 100 : 0,
    p50_ms: Math.round(pXX(sorted, 50) * 1000) / 1000,
    p90_ms: Math.round(pXX(sorted, 90) * 1000) / 1000,
    p99_ms: Math.round(pXX(sorted, 99) * 1000) / 1000,
    min_ms: ops > 0 ? Math.round(sorted[0]! * 1000) / 1000 : NaN,
    max_ms: ops > 0 ? Math.round(sorted[ops - 1]! * 1000) / 1000 : NaN,
  };
}

async function seedMemoriesDirect(
  store: SqliteMemoryStore,
  count: number,
  rng: () => number,
  dims = 384
): Promise<{ seeded: number; errors: number; wallMs: number }> {
  let seeded = 0;
  let errors = 0;
  const t0 = performance.now();
  const now = new Date().toISOString();

  for (let i = 0; i < count; i++) {
    const content = buildContent(rng, i);
    const recordId = `bench_seed_${i}_${crypto.randomUUID()}`;
    const record: L1Record = {
      id: recordId,
      userId: "load_user",
      sessionKey: "load_session",
      sessionId: "load_session_id",
      content,
      type: "episodic",
      priority: 5,
      sceneName: "",
      skillTag: "general",
      halfLifeDays: 30,
      supersededBy: null,
      invalidAt: null,
      timestampStr: now,
      timestampStart: now,
      timestampEnd: now,
      createdTime: now,
      updatedTime: now,
      metadata: {},
      citationCount: 0,
      lastCitedAt: null,
      neverCitedCount: 0,
      archived: false
    };

    try {
      store.upsertL1(record);
      store.upsertL1Vec(recordId, deterministicEmbedding(content, dims));
      seeded++;
    } catch (_) {
      errors++;
    }
  }

  return { seeded, errors, wallMs: performance.now() - t0 };
}

async function measureRememberDirect(
  store: SqliteMemoryStore,
  rng: () => number,
  N: number,
  C: number,
  ops: number,
  dims = 384
): Promise<CellResult> {
  const now = new Date().toISOString();
  const { latencies, errors, wallMs } = await driveLoad(C, ops, async (i) => {
    const content = buildContent(rng, N + i);
    const recordId = `bench_remember_${N}_${i}_${crypto.randomUUID()}`;
    const record: L1Record = {
      id: recordId,
      userId: "load_user",
      sessionKey: "load_session",
      sessionId: "load_session_id",
      content,
      type: "episodic",
      priority: 5,
      sceneName: "",
      skillTag: "general",
      halfLifeDays: 30,
      supersededBy: null,
      invalidAt: null,
      timestampStr: now,
      timestampStart: now,
      timestampEnd: now,
      createdTime: now,
      updatedTime: now,
      metadata: {},
      citationCount: 0,
      lastCitedAt: null,
      neverCitedCount: 0,
      archived: false
    };

    store.upsertL1(record);
    store.upsertL1Vec(recordId, deterministicEmbedding(content, dims));
  });

  return summarize("L1Store.upsertL1 (in-process)", N, C, latencies, errors, wallMs);
}

async function measureSmartSearchDirect(
  store: SqliteMemoryStore,
  rng: () => number,
  N: number,
  C: number,
  ops: number,
  dims = 384
): Promise<CellResult> {
  const queries = Array.from({ length: 32 }, (_, i) => buildContent(rng, i));
  const queryVecs = queries.map(q => deterministicEmbedding(q, dims));

  const { latencies, errors, wallMs } = await driveLoad(C, ops, async (i) => {
    const query = queries[i % queries.length];
    const queryVec = queryVecs[i % queryVecs.length];

    // Blends FTS and Vector search outputs using RRF formulas
    const ftsResults = store.searchL1Fts("load_user", query, 5);
    const vecResults = store.searchL1Vec("load_user", queryVec, 5);

    const rrfMap = new Map<string, number>();
    ftsResults.forEach((r, idx) => {
      rrfMap.set(r.record_id, 1 / (60 + idx + 1));
    });
    vecResults.forEach((r, idx) => {
      rrfMap.set(r.record_id, (rrfMap.get(r.record_id) || 0) + (1 / (60 + idx + 1)));
    });

    const blended = Array.from(rrfMap.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (blended.length === -1) throw new Error(); // Unreachable block to satisfy Typescript
  });

  return summarize("HybridBlendedSearch (in-process)", N, C, latencies, errors, wallMs);
}

async function measureMemoriesLatestDirect(
  store: SqliteMemoryStore,
  N: number,
  C: number,
  ops: number
): Promise<CellResult> {
  const { latencies, errors, wallMs } = await driveLoad(C, ops, async () => {
    // Replicates a GET /memories?latest=true style query
    const results = (store as any).db
      .prepare("SELECT * FROM l1_records WHERE user_id = ? AND archived = 0 ORDER BY created_time DESC LIMIT 10")
      .all("load_user");

    if (!results) throw new Error();
  });

  return summarize("ChronologicalRetr.latest (in-process)", N, C, latencies, errors, wallMs);
}

interface RunReport {
  schema_version: 1;
  generated_at: string;
  git_sha: string;
  engine: "BrainRouter (SQLite in-process)";
  seed: number;
  matrix: { N: number[]; C: number[] };
  ops_per_cell: number;
  cells: CellResult[];
  notes: string;
}

function shortGitSha(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha) return sha;
  } catch {
    /* no git */
  }
  return `nogit-${Date.now().toString(36)}`;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log("==================================================");
  console.log("⚡ BRAINROUTER IN-PROCESS 100K SCALE LOAD TEST");
  console.log("==================================================");
  console.log(`Matrix: N=[${cfg.Ns.join(",")}] C=[${cfg.Cs.join(",")}] ops/cell=${cfg.opsPerCell} seed=${cfg.seed}\n`);

  if (existsSync(DB_PATH)) {
    try {
      unlinkSync(DB_PATH);
    } catch (_) {}
  }
  const store = new SqliteMemoryStore(DB_PATH);
  store.init();
  const dims = 384;
  store.initVec(dims);

  try {
    const cells: CellResult[] = [];
    const sortedNs = cfg.Ns.slice().sort((a, b) => a - b);
    let seededSoFar = 0;

    for (const N of sortedNs) {
      const delta = N - seededSoFar;
      if (delta > 0) {
        console.log(`[load-100k] seeding ${delta} memories in-process (target N=${N})...`);
        const rng = mulberry32(cfg.seed + seededSoFar);
        const seedRes = await seedMemoriesDirect(store, delta, rng, dims);
        seededSoFar += seedRes.seeded;
        console.log(`[load-100k]   seeded=${seedRes.seeded} errors=${seedRes.errors} wall=${(seedRes.wallMs / 1000).toFixed(2)}s`);
      }

      for (const C of cfg.Cs) {
        const probeRng = mulberry32(cfg.seed ^ (N * 0x9e3779b1) ^ C);

        console.log(`[load-100k] cell N=${N} C=${C} L1 ingest (remember)...`);
        const remember = await measureRememberDirect(store, probeRng, N, C, cfg.opsPerCell, dims);
        cells.push(remember);

        console.log(`[load-100k] cell N=${N} C=${C} hybrid blended search...`);
        const search = await measureSmartSearchDirect(store, mulberry32(cfg.seed ^ (N * 0x85ebca77) ^ C), N, C, cfg.opsPerCell, dims);
        cells.push(search);

        console.log(`[load-100k] cell N=${N} C=${C} chronological retrieval (latest)...`);
        const memories = await measureMemoriesLatestDirect(store, N, C, cfg.opsPerCell);
        cells.push(memories);
      }
    }

    const report: RunReport = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      git_sha: shortGitSha(),
      engine: "BrainRouter (SQLite in-process)",
      seed: cfg.seed,
      matrix: { N: sortedNs, C: cfg.Cs.slice() },
      ops_per_cell: cfg.opsPerCell,
      cells,
      notes: "Direct, local memory engine benchmark utilizing fast, in-process C-based SQLite virtual tables with zero HTTP overhead.",
    };

    const outDir = cfg.outDir || getIncrementalOutputDir();
    const outPath = join(outDir, `load-100k-${report.git_sha}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`\n[load-100k] successfully wrote ${outPath} (${cells.length} cells)`);

    // Output formatted comparison table
    console.log("");
    console.log(
      [
        "In-Process Memory Operation".padEnd(42),
        "N".padStart(8),
        "C".padStart(4),
        "ops".padStart(6),
        "err".padStart(4),
        "p50_ms".padStart(8),
        "p90_ms".padStart(8),
        "p99_ms".padStart(8),
        "tp/s".padStart(9),
      ].join(" ")
    );
    console.log("-".repeat(102));

    for (const c of cells) {
      console.log(
        [
          c.endpoint.padEnd(42),
          String(c.N).padStart(8),
          String(c.C).padStart(4),
          String(c.ops).padStart(6),
          String(c.errors).padStart(4),
          c.p50_ms.toFixed(2).padStart(8),
          c.p90_ms.toFixed(2).padStart(8),
          c.p99_ms.toFixed(2).padStart(8),
          c.throughput_per_sec.toFixed(2).padStart(9),
        ].join(" ")
      );
    }

  } finally {
    try {
      (store as any).db?.close();
    } catch (_) {}
    try {
      if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
      const wal = `${DB_PATH}-wal`;
      if (existsSync(wal)) unlinkSync(wal);
      const shm = `${DB_PATH}-shm`;
      if (existsSync(shm)) unlinkSync(shm);
    } catch (_) {}
  }
}

main().catch((err) => {
  console.error("[load-100k] failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});

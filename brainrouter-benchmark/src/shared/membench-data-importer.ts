import fs from "node:fs";
import path from "node:path";
import { datasetPath, loadDatasetManifest, benchmarkPackageRoot } from "./dataset-resolver.js";
import type { BenchmarkDataset, BenchmarkQuery, BenchmarkRecord } from "./schema.js";

// MemBench data2test importer.
//
// Converts the upstream MemBench `data/{First,Third}AgentData{Low,High}Level.json`
// archives into BenchmarkDataset format for the 10k/100k length splits.
//
// Gold mapping is by STABLE id (`sid` for participation turns, `mid` for
// observation messages), disambiguated by the session index carried in
// `QA.target_step_id` entries. This is robust to noise interleaving: the paper
// pads conversations with distractor "noise" units to reach a target token
// length, and we reproduce that difficulty by emitting each noise message as an
// extra distractor record. Because gold is resolved by id (not by post-noise
// position) the padding never corrupts the ground truth.

type RawMsg = Record<string, unknown>;

interface RawQA {
  qid?: number;
  question?: string;
  answer?: string;
  target_step_id?: unknown;
  choices?: Record<string, string>;
  ground_truth?: string;
}

interface RawTraj {
  tid?: number;
  gid?: number;
  message_list?: unknown;
  QA?: RawQA;
}

// QAtype -> scenario -> trajectories
type RawSplit = Record<string, Record<string, RawTraj[]>>;

interface NoiseUnit {
  nid?: number;
  noise_message?: RawMsg[];
}

export type MemBenchFamily = "first" | "third";

export interface ImportSplitOptions {
  rawFile: string;
  outputPath: string;
  splitId: string;
  scenario: "participation" | "observation";
  memoryLevel: "factual" | "reflective";
  family: MemBenchFamily;
  /** Number of distractor noise units (≈1k tokens each) interleaved per trajectory. */
  noiseUnits: number;
  /** Trajectories sampled per (QAtype, scenario). MemBench uses 100. */
  sampleNum?: number;
  seed?: number;
  noiseFile?: string;
}

export interface ImportSplitResult {
  outputPath: string;
  records: number;
  queries: number;
  trajectories: number;
  noiseRecords: number;
}

// Deterministic PRNG (mulberry32) — keeps split generation reproducible without
// depending on Math.random.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Partial Fisher-Yates: deterministic sample of up to `n` distinct items.
function sample<T>(items: T[], n: number, rng: () => number): T[] {
  if (items.length <= n) return items.slice();
  const arr = items.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr.slice(0, n);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function idValue(msg: RawMsg): number | undefined {
  if (typeof msg.sid === "number") return msg.sid;
  if (typeof msg.mid === "number") return msg.mid;
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function contentFor(msg: RawMsg): string {
  const time = asString(msg.time);
  const place = asString(msg.place);
  const user = asString(msg.user_message) ?? asString(msg.user);
  const assistant = asString(msg.assistant_message) ?? asString(msg.assistant);
  const message = asString(msg.message);
  const rel = asString(msg.rel);
  const attr = asString(msg.attr);
  const value = asString(msg.value);
  const parts = [
    time ? `Time: ${time}` : undefined,
    place ? `Place: ${place}` : undefined,
    message ? `Observation: ${message}` : undefined,
    user ? `User: ${user}` : undefined,
    assistant ? `Assistant: ${assistant}` : undefined,
    rel && attr && value ? `Gold attribute: ${rel}.${attr} = ${value}` : undefined,
  ];
  return parts.filter(Boolean).join("\n");
}

// message_list is either a flat list of messages or a list of sessions
// (list-of-lists). Track which session each message came from so target ids
// that carry a session index resolve unambiguously.
function flattenSessions(messageList: unknown): Array<{ sessionIdx: number; msg: RawMsg }> {
  const out: Array<{ sessionIdx: number; msg: RawMsg }> = [];
  if (!Array.isArray(messageList)) return out;
  const nested = messageList.length > 0 && Array.isArray(messageList[0]);
  if (nested) {
    (messageList as unknown[][]).forEach((session, sessionIdx) => {
      if (!Array.isArray(session)) return;
      for (const msg of session) {
        if (msg && typeof msg === "object") out.push({ sessionIdx, msg: msg as RawMsg });
      }
    });
  } else {
    for (const msg of messageList as unknown[]) {
      if (msg && typeof msg === "object") out.push({ sessionIdx: 0, msg: msg as RawMsg });
    }
  }
  return out;
}

function resolveGold(target: unknown, byComposite: Map<string, string>, byId: Map<string, string>): string[] {
  if (!Array.isArray(target)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of target) {
    let id: number | undefined;
    let sess: number | undefined;
    if (Array.isArray(entry)) {
      id = Number(entry[0]);
      sess = entry.length > 1 ? Number(entry[1]) : undefined;
    } else if (typeof entry === "number") {
      id = entry;
    }
    if (id == null || !Number.isFinite(id)) continue;
    let rec: string | undefined;
    if (sess != null && Number.isFinite(sess)) rec = byComposite.get(`${sess}:${id}`) ?? byId.get(String(id));
    else rec = byId.get(String(id));
    if (rec && !seen.has(rec)) {
      seen.add(rec);
      out.push(rec);
    }
  }
  return out;
}

function defaultNoiseFile(family: MemBenchFamily, rawFile: string): string {
  const membenchRoot = path.resolve(path.dirname(rawFile), "..");
  return path.join(membenchRoot, "NoiseData", family === "first" ? "FirstNoise.json" : "ThirdNoise.json");
}

export function importMemBenchDataSplit(opts: ImportSplitOptions): ImportSplitResult {
  const sampleNum = opts.sampleNum ?? 100;
  const seed = opts.seed ?? 1337;
  const rng = makeRng(seed);
  const rawFile = path.resolve(opts.rawFile);
  if (!fs.existsSync(rawFile)) {
    throw new Error(`MemBench raw split not found: ${rawFile}`);
  }

  const noiseFile = path.resolve(opts.noiseFile ?? defaultNoiseFile(opts.family, rawFile));
  const noisePool: NoiseUnit[] =
    opts.noiseUnits > 0 && fs.existsSync(noiseFile) ? (JSON.parse(fs.readFileSync(noiseFile, "utf8")) as NoiseUnit[]) : [];
  if (opts.noiseUnits > 0 && noisePool.length === 0) {
    throw new Error(`Noise requested (${opts.noiseUnits}) but noise pool is empty/missing: ${noiseFile}`);
  }

  const raw = JSON.parse(fs.readFileSync(rawFile, "utf8")) as RawSplit;
  const records: BenchmarkRecord[] = [];
  const queries: BenchmarkQuery[] = [];
  const usedRecordIds = new Set<string>();
  const splitShort = slug(opts.splitId);
  let trajectories = 0;
  let noiseRecords = 0;

  for (const [qaType, scenarios] of Object.entries(raw)) {
    if (!scenarios || typeof scenarios !== "object") continue;
    for (const [scenarioName, trajList] of Object.entries(scenarios)) {
      if (!Array.isArray(trajList)) continue;
      for (const traj of sample(trajList, sampleNum, rng)) {
        trajectories++;
        const tid = traj.tid ?? traj.gid ?? trajectories;
        const sessionId = `${splitShort}-${slug(qaType)}-${slug(scenarioName)}-${tid}`;
        const byComposite = new Map<string, string>();
        const byId = new Map<string, string>();

        for (const { sessionIdx, msg } of flattenSessions(traj.message_list)) {
          const idVal = idValue(msg);
          const recordId = `${sessionId}-m-${sessionIdx}-${idVal ?? `x${records.length}`}`;
          if (usedRecordIds.has(recordId)) continue;
          usedRecordIds.add(recordId);
          if (idVal != null) {
            byComposite.set(`${sessionIdx}:${idVal}`, recordId);
            if (!byId.has(String(idVal))) byId.set(String(idVal), recordId);
          }
          records.push({
            id: recordId,
            sessionId,
            role: opts.family === "first" ? "conversation-turn" : "observation",
            timestamp: asString(msg.time),
            content: contentFor(msg),
            metadata: { source: "MemBench", split: opts.splitId, qaType, scenario: scenarioName, kind: "signal" },
          });
        }

        if (opts.noiseUnits > 0 && noisePool.length > 0) {
          sample(noisePool, opts.noiseUnits, rng).forEach((unit, ui) => {
            const msgs = Array.isArray(unit.noise_message) ? unit.noise_message : [];
            msgs.forEach((nmsg, mi) => {
              const recordId = `${sessionId}-noise-${unit.nid ?? ui}-${mi}`;
              if (usedRecordIds.has(recordId)) return;
              usedRecordIds.add(recordId);
              noiseRecords++;
              records.push({
                id: recordId,
                sessionId,
                role: "noise",
                content: contentFor(nmsg as RawMsg),
                metadata: { source: "MemBench", split: opts.splitId, qaType, scenario: scenarioName, kind: "noise" },
              });
            });
          });
        }

        const qa = traj.QA;
        if (!qa || typeof qa.question !== "string") continue;
        const gold = resolveGold(qa.target_step_id, byComposite, byId);
        if (gold.length === 0) continue;
        queries.push({
          id: `${sessionId}-q-${qa.qid ?? queries.length}`,
          query: qa.question,
          answer: asString(qa.answer),
          options: qa.choices ? Object.entries(qa.choices).map(([key, value]) => `${key}. ${value}`) : undefined,
          correctOption: asString(qa.ground_truth),
          goldRecordIds: gold,
          category: `${qaType}/${scenarioName}`,
          scenario: opts.scenario,
          memoryLevel: opts.memoryLevel,
        });
      }
    }
  }

  const dataset: BenchmarkDataset = {
    id: opts.splitId.replace(/:/g, "-"),
    version: "2506.21605-data2test",
    source: `MemBench ${opts.splitId} (${path.basename(rawFile)}, noise×${opts.noiseUnits})`,
    description: `Converted MemBench ${opts.scenario} ${opts.memoryLevel} split ${opts.splitId}. ${opts.noiseUnits} distractor noise units (~1k tokens each) interleaved per trajectory; gold mapped by stable sid/mid.`,
    metadata: {
      sourceUrl: "https://github.com/import-myself/Membench",
      scenario: opts.scenario,
      memoryLevel: opts.memoryLevel,
      split: opts.splitId,
      noiseUnits: opts.noiseUnits,
      sampleNum,
      seed,
      rawFile: path.basename(rawFile),
      noiseRecords,
    },
    records,
    queries,
  };

  fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
  fs.writeFileSync(opts.outputPath, `${JSON.stringify(dataset, null, 2)}\n`);
  return { outputPath: opts.outputPath, records: records.length, queries: queries.length, trajectories, noiseRecords };
}

interface SplitFamilyConfig {
  rawFileName: string;
  family: MemBenchFamily;
  scenario: "participation" | "observation";
  memoryLevel: "factual" | "reflective";
}

const SPLIT_FAMILY: Record<string, SplitFamilyConfig> = {
  "ps-fm": { rawFileName: "FirstAgentDataLowLevel.json", family: "first", scenario: "participation", memoryLevel: "factual" },
  "ps-rm": { rawFileName: "FirstAgentDataHighLevel.json", family: "first", scenario: "participation", memoryLevel: "reflective" },
  "os-fm": { rawFileName: "ThirdAgentDataLowLevel.json", family: "third", scenario: "observation", memoryLevel: "factual" },
  "os-rm": { rawFileName: "ThirdAgentDataHighLevel.json", family: "third", scenario: "observation", memoryLevel: "reflective" },
};

const LENGTH_NOISE: Record<string, number> = { "10k": 10, "100k": 100 };

export interface BuildSplitOptions {
  splitId: string;
  sampleNum?: number;
  seed?: number;
}

// Resolve a manifest split id (e.g. "membench:ps-fm:10k") to raw file + params
// and convert it to the manifest's expected output path.
export function buildMemBenchSplit(opts: BuildSplitOptions): ImportSplitResult {
  const match = /^membench:(ps-fm|ps-rm|os-fm|os-rm):(10k|100k)$/.exec(opts.splitId);
  if (!match) {
    throw new Error(
      `Unsupported split "${opts.splitId}". Expected membench:{ps-fm,ps-rm,os-fm,os-rm}:{10k,100k}.`,
    );
  }
  const [, familyKey, lengthBucket] = match;
  const cfg = SPLIT_FAMILY[familyKey];
  const noiseUnits = LENGTH_NOISE[lengthBucket];

  const manifest = loadDatasetManifest("membench");
  const split = manifest.splits.find((candidate) => candidate.id === opts.splitId);
  if (!split) throw new Error(`Split ${opts.splitId} is not declared in membench.manifest.json`);

  const rawFile = datasetPath("raw", "membench", "Membenchdata", "data", cfg.rawFileName);
  const outputPath = path.resolve(benchmarkPackageRoot(), split.expectedConvertedPath);

  return importMemBenchDataSplit({
    rawFile,
    outputPath,
    splitId: opts.splitId,
    scenario: cfg.scenario,
    memoryLevel: cfg.memoryLevel,
    family: cfg.family,
    noiseUnits,
    sampleNum: opts.sampleNum,
    seed: opts.seed,
  });
}

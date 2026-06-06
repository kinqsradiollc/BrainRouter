import fs from "node:fs";
import path from "node:path";
import { datasetPath } from "./dataset-resolver.js";
import type { BenchmarkDataset, BenchmarkQuery, BenchmarkRecord } from "./schema.js";

interface MemBenchTurn {
  sid?: number;
  user_message?: string;
  assistant_message?: string;
  time?: string;
  place?: string;
  rel?: string;
  attr?: string;
  value?: string;
}

interface MemBenchQa {
  qid?: number;
  question?: string;
  answer?: string;
  target_step_id?: Array<[number, number]>;
  choices?: Record<string, string>;
  ground_truth?: string;
  time?: string;
}

interface MemBenchItem {
  tid?: number;
  message_list?: MemBenchTurn[][];
  QA?: MemBenchQa;
}

interface MemBenchFirstAgentSimple {
  roles?: MemBenchItem[];
  events?: MemBenchItem[];
}

export interface ImportMemBenchOptions {
  inputPath?: string;
  outputPath?: string;
  limitItems?: number;
}

function turnContent(turn: MemBenchTurn): string {
  const parts = [
    turn.time ? `Time: ${turn.time}` : undefined,
    turn.place ? `Place: ${turn.place}` : undefined,
    turn.user_message ? `User: ${turn.user_message}` : undefined,
    turn.assistant_message ? `Assistant: ${turn.assistant_message}` : undefined,
    turn.rel && turn.attr && turn.value ? `Gold attribute: ${turn.rel}.${turn.attr} = ${turn.value}` : undefined,
  ];
  return parts.filter(Boolean).join("\n");
}

function normalizeItem(
  kind: "role" | "event",
  item: MemBenchItem,
  index: number,
  records: BenchmarkRecord[],
  queries: BenchmarkQuery[],
): void {
  const sessionId = `membench-firstagent-simple-${kind}-${item.tid ?? index}`;
  const sidToRecordId = new Map<number, string>();
  const turns = (item.message_list ?? []).flat();

  for (const turn of turns) {
    if (typeof turn.sid !== "number") continue;
    const recordId = `${sessionId}-turn-${turn.sid}`;
    sidToRecordId.set(turn.sid, recordId);
    records.push({
      id: recordId,
      sessionId,
      role: "conversation-turn",
      timestamp: turn.time,
      content: turnContent(turn),
      metadata: {
        source: "MemBench",
        upstreamDataset: "MemData/FirstAgent/simple.json",
        itemKind: kind,
        tid: item.tid ?? index,
        sid: turn.sid,
        place: turn.place,
        relation: turn.rel,
        attribute: turn.attr,
        value: turn.value,
      },
    });
  }

  const qa = item.QA;
  if (!qa?.question) return;
  const goldRecordIds = (qa.target_step_id ?? [])
    .map(([sid]) => sidToRecordId.get(sid))
    .filter((id): id is string => Boolean(id));
  if (goldRecordIds.length === 0) return;

  queries.push({
    id: `${sessionId}-q-${qa.qid ?? 0}`,
    query: qa.question,
    answer: qa.answer,
    options: qa.choices ? Object.entries(qa.choices).map(([key, value]) => `${key}. ${value}`) : undefined,
    correctOption: qa.ground_truth,
    goldRecordIds,
    category: `membench-firstagent-simple-${kind}`,
    scenario: "participation",
    memoryLevel: "factual",
  });
}

export function importMemBenchFirstAgentSimple(opts: ImportMemBenchOptions = {}): { outputPath: string; records: number; queries: number } {
  const inputPath = path.resolve(opts.inputPath ?? datasetPath("raw", "membench-firstagent-simple.json"));
  const outputPath = path.resolve(opts.outputPath ?? datasetPath("membench", "ps-fm-github-simple.json"));
  if (!fs.existsSync(inputPath)) {
    throw new Error(`MemBench raw file not found: ${inputPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(inputPath, "utf8")) as MemBenchFirstAgentSimple;
  const records: BenchmarkRecord[] = [];
  const queries: BenchmarkQuery[] = [];
  const limit = opts.limitItems ?? Number.POSITIVE_INFINITY;

  for (const [index, item] of (raw.roles ?? []).slice(0, limit).entries()) {
    normalizeItem("role", item, index, records, queries);
  }
  for (const [index, item] of (raw.events ?? []).slice(0, limit).entries()) {
    normalizeItem("event", item, index, records, queries);
  }

  const dataset: BenchmarkDataset = {
    id: "membench-ps-fm-github-simple",
    version: "2506.21605-github-memdata",
    source: "MemBench MemData/FirstAgent/simple.json",
    description: "Converted MemBench participation factual simple category from the public GitHub MemData subset.",
    metadata: {
      sourceUrl: "https://github.com/import-myself/Membench/blob/main/MemData/FirstAgent/simple.json",
      scenario: "participation",
      memoryLevel: "factual",
      split: "membench:ps-fm:github-simple",
    },
    records,
    queries,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(dataset, null, 2)}\n`);
  return { outputPath, records: records.length, queries: queries.length };
}

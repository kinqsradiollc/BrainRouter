import fs from "node:fs";
import path from "node:path";
import { datasetPath } from "./dataset-resolver.js";
import type { BenchmarkDataset, BenchmarkQuery, BenchmarkRecord } from "./schema.js";

// ───────────────────────── LongMemEval ─────────────────────────
// Each question carries its own haystack of sessions + answer_session_ids (gold).
// We build a global-union corpus (records = unique sessions across all questions);
// gold = answer_session_ids. Session-level retrieval → score with recall_any@k.

interface LmeTurn { role?: string; content?: string }
interface LmeQuestion {
  question_id?: string;
  question_type?: string;
  question?: string;
  answer?: string;
  answer_session_ids?: string[];
  haystack_session_ids?: string[];
  haystack_sessions?: LmeTurn[][];
}

function sessionContent(turns: LmeTurn[]): string {
  return (turns ?? [])
    .map((t) => `${t.role ?? "user"}: ${t.content ?? ""}`)
    .join("\n");
}

export function buildLongMemEval(opts: { inputPath?: string; outputPath?: string; limitQuestions?: number } = {}): { outputPath: string; records: number; queries: number } {
  const inputPath = path.resolve(opts.inputPath ?? datasetPath("raw", "longmemeval_s.json"));
  const outputPath = path.resolve(opts.outputPath ?? datasetPath("longmemeval", "longmemeval-s.json"));
  if (!fs.existsSync(inputPath)) throw new Error(`LongMemEval raw file not found: ${inputPath}`);

  const raw = JSON.parse(fs.readFileSync(inputPath, "utf8")) as LmeQuestion[];
  const questions = Array.isArray(raw) ? raw : [];
  const limit = opts.limitQuestions ?? Number.POSITIVE_INFINITY;

  const records: BenchmarkRecord[] = [];
  const seen = new Set<string>();
  const queries: BenchmarkQuery[] = [];

  for (const [qi, q] of questions.slice(0, limit).entries()) {
    const ids = q.haystack_session_ids ?? [];
    const sessions = q.haystack_sessions ?? [];
    for (let i = 0; i < sessions.length; i++) {
      const sid = ids[i] ?? `${q.question_id ?? qi}-sess-${i}`;
      if (seen.has(sid)) continue;
      seen.add(sid);
      records.push({
        id: sid,
        sessionId: sid,
        role: "session",
        content: sessionContent(sessions[i]),
        metadata: { source: "LongMemEval-S" },
      });
    }
    const gold = (q.answer_session_ids ?? []).filter((g): g is string => Boolean(g) && seen.has(g));
    if (!q.question || gold.length === 0) continue;
    queries.push({
      id: q.question_id ?? `lme-${qi}`,
      query: q.question,
      answer: q.answer,
      goldRecordIds: gold,
      category: q.question_type ?? "longmemeval",
    });
  }

  const dataset: BenchmarkDataset = {
    id: "longmemeval-s",
    version: "longmemeval-s-cleaned",
    source: "LongMemEval-S (ICLR 2025)",
    description: "LongMemEval-S session retrieval. Global-union corpus of all haystack sessions; gold = answer_session_ids. Headline metric is recall_any@k (does any gold session surface).",
    metadata: { metric: "recall_any@k", granularity: "session", globalCorpus: true },
    records,
    queries,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(dataset, null, 2)}\n`);
  return { outputPath, records: records.length, queries: queries.length };
}

// ───────────────────────── LoCoMo ─────────────────────────
// Each sample is a two-speaker multi-session conversation with QA whose evidence
// points at turn dia_ids ("D1:3"). Records = turns (global union across samples,
// id = "<sample>/<dia_id>"); gold = evidence turns. Score with recall@k.

interface LocoTurn { speaker?: string; dia_id?: string; text?: string }
interface LocoQa { question?: string; answer?: string | number; evidence?: string[]; category?: number | string }
interface LocoSample { sample_id?: string; conversation?: Record<string, unknown>; qa?: LocoQa[] }

export function buildLoCoMo(opts: { inputPath?: string; outputPath?: string; limitSamples?: number } = {}): { outputPath: string; records: number; queries: number; skipped: number } {
  const inputPath = path.resolve(opts.inputPath ?? datasetPath("raw", "locomo10.json"));
  const outputPath = path.resolve(opts.outputPath ?? datasetPath("locomo", "locomo.json"));
  if (!fs.existsSync(inputPath)) throw new Error(`LoCoMo raw file not found: ${inputPath}`);

  const raw = JSON.parse(fs.readFileSync(inputPath, "utf8")) as LocoSample[];
  const samples = Array.isArray(raw) ? raw : [];
  const limit = opts.limitSamples ?? Number.POSITIVE_INFINITY;

  const records: BenchmarkRecord[] = [];
  const queries: BenchmarkQuery[] = [];
  let skipped = 0;

  for (const [si, sample] of samples.slice(0, limit).entries()) {
    const sampleId = sample.sample_id ?? `sample-${si}`;
    const localIds = new Set<string>();
    const conv = sample.conversation ?? {};
    for (const key of Object.keys(conv)) {
      if (!/^session_\d+$/.test(key)) continue;
      const turns = conv[key];
      if (!Array.isArray(turns)) continue;
      for (const turn of turns as LocoTurn[]) {
        if (!turn?.dia_id) continue;
        const recId = `${sampleId}/${turn.dia_id}`;
        if (localIds.has(recId)) continue;
        localIds.add(recId);
        records.push({
          id: recId,
          sessionId: `${sampleId}/${key}`,
          role: "conversation-turn",
          content: `${turn.speaker ?? "speaker"}: ${turn.text ?? ""}`,
          metadata: { source: "LoCoMo", sampleId, session: key, diaId: turn.dia_id },
        });
      }
    }
    for (const [qi, qa] of (sample.qa ?? []).entries()) {
      const gold = (qa.evidence ?? [])
        .map((e) => `${sampleId}/${e}`)
        .filter((id) => localIds.has(id));
      if (!qa.question || gold.length === 0) { skipped++; continue; }
      queries.push({
        id: `${sampleId}-q${qi}`,
        query: qa.question,
        answer: qa.answer != null ? String(qa.answer) : undefined,
        goldRecordIds: gold,
        category: `locomo-cat${qa.category ?? "?"}`,
      });
    }
  }

  const dataset: BenchmarkDataset = {
    id: "locomo",
    version: "locomo10",
    source: "LoCoMo (snap-research)",
    description: "LoCoMo multi-session conversational QA. Global-union corpus of turns across all samples; gold = evidence turns. Score with recall@k. (Adversarial/no-evidence QA are skipped.)",
    metadata: { metric: "recall@k", granularity: "turn", globalCorpus: true },
    records,
    queries,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(dataset, null, 2)}\n`);
  return { outputPath, records: records.length, queries: queries.length, skipped };
}

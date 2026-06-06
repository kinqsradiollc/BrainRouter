import fs from "node:fs";
import path from "node:path";
import type { BenchmarkDataset, BenchmarkQuery, BenchmarkRecord } from "./schema.js";

export interface DatasetValidationResult {
  ok: boolean;
  dataset?: BenchmarkDataset;
  errors: string[];
  filePath: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateBenchmarkDataset(raw: unknown): { dataset?: BenchmarkDataset; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) {
    return { errors: ["dataset must be a JSON object"] };
  }

  const id = typeof raw.id === "string" ? raw.id : "";
  const version = typeof raw.version === "string" ? raw.version : "";
  const source = typeof raw.source === "string" ? raw.source : "";
  const description = typeof raw.description === "string" ? raw.description : undefined;
  const recordsRaw = Array.isArray(raw.records) ? raw.records : [];
  const queriesRaw = Array.isArray(raw.queries) ? raw.queries : [];

  if (!id) errors.push("id is required");
  if (!version) errors.push("version is required");
  if (!source) errors.push("source is required");
  if (!Array.isArray(raw.records)) errors.push("records must be an array");
  if (!Array.isArray(raw.queries)) errors.push("queries must be an array");
  if (recordsRaw.length === 0) errors.push("records must not be empty");
  if (queriesRaw.length === 0) errors.push("queries must not be empty");

  const recordIds = new Set<string>();
  const records = recordsRaw.flatMap((record, index) => {
    if (!isObject(record)) {
      errors.push(`records[${index}] must be an object`);
      return [];
    }
    const recordId = typeof record.id === "string" ? record.id : "";
    const content = typeof record.content === "string" ? record.content : "";
    if (!recordId) errors.push(`records[${index}].id is required`);
    if (!content) errors.push(`records[${index}].content is required`);
    if (recordIds.has(recordId)) errors.push(`duplicate record id: ${recordId}`);
    if (recordId) recordIds.add(recordId);
    const parsedRecord: BenchmarkRecord = {
      id: recordId,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
      role: typeof record.role === "string" ? record.role : undefined,
      timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
      content,
      metadata: isObject(record.metadata) ? record.metadata : undefined,
    };
    return [parsedRecord];
  });

  const queries = queriesRaw.flatMap((query, index) => {
    if (!isObject(query)) {
      errors.push(`queries[${index}] must be an object`);
      return [];
    }
    const queryId = typeof query.id === "string" ? query.id : "";
    const text = typeof query.query === "string" ? query.query : "";
    const goldRecordIds = Array.isArray(query.goldRecordIds) ? query.goldRecordIds.map(String) : [];
    const scenario = query.scenario === "participation" || query.scenario === "observation" ? query.scenario : undefined;
    const memoryLevel = query.memoryLevel === "factual" || query.memoryLevel === "reflective" ? query.memoryLevel : undefined;
    if (!queryId) errors.push(`queries[${index}].id is required`);
    if (!text) errors.push(`queries[${index}].query is required`);
    if (goldRecordIds.length === 0) errors.push(`queries[${index}].goldRecordIds must not be empty`);
    for (const gold of goldRecordIds) {
      if (!recordIds.has(gold)) errors.push(`queries[${index}] references missing gold record: ${gold}`);
    }
    const parsedQuery: BenchmarkQuery = {
      id: queryId,
      query: text,
      goldRecordIds,
      answer: typeof query.answer === "string" ? query.answer : undefined,
      options: Array.isArray(query.options) ? query.options.map(String) : undefined,
      correctOption: typeof query.correctOption === "string" ? query.correctOption : undefined,
      category: typeof query.category === "string" ? query.category : undefined,
      scenario,
      memoryLevel,
    };
    return [parsedQuery];
  });

  return {
    dataset: errors.length === 0 ? {
      id,
      version,
      source,
      description,
      metadata: isObject(raw.metadata) ? raw.metadata : undefined,
      records,
      queries,
    } : undefined,
    errors,
  };
}

export function loadAndValidateDataset(filePath: string): DatasetValidationResult {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return { ok: false, errors: ["dataset file does not exist"], filePath: resolved };
  }
  const stat = fs.statSync(resolved);
  if (stat.size === 0) {
    return { ok: false, errors: ["dataset file is zero bytes"], filePath: resolved };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (err) {
    return {
      ok: false,
      errors: [`dataset JSON is malformed: ${err instanceof Error ? err.message : String(err)}`],
      filePath: resolved,
    };
  }
  const { dataset, errors } = validateBenchmarkDataset(parsed);
  return { ok: errors.length === 0, dataset, errors, filePath: resolved };
}

export function fixturePath(name: string): string {
  return path.resolve(process.cwd(), "datasets", `${name}.json`);
}

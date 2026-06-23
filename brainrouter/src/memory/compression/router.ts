import { estimateTokens } from "./tokens.js";
import type { CompressResult, ContentKind } from "./types.js";

const ERROR_PATTERN = /ERROR|EXCEPTION|FAIL|FATAL|PANIC|TRACEBACK|WARN/i;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const CODE_PATTERN = /\b(def|class|function|func|fn|import|const|public)\b/;
const DEFAULT_MIN_ITEMS = 20;
const DEFAULT_TARGET_KEEP = 0.2;
const DEFAULT_MIN_KEEP = 8;

export interface CompressionStore {
  storeCompressionEntry(input: {
    userId: string;
    originalContent: string;
    compressedContent?: string | null;
    originalTokens?: number | null;
    compressedTokens?: number | null;
    originalItemCount?: number | null;
    compressedItemCount?: number | null;
    toolName?: string | null;
    queryContext?: string | null;
    compressionStrategy?: string | null;
    // Backed by either a synchronous store (direct injection / unit tests) or
    // the asyncified one — accept both and `await` (a no-op on a non-Promise).
  }): { hash: string } | Promise<{ hash: string }>;
}

export interface CompressOptions {
  userId: string;
  store: CompressionStore;
  queryContext?: string;
  toolName?: string;
  targetKeep?: number;
  minItems?: number;
  minKeep?: number;
  preferLossless?: boolean;
  strategy?: "auto" | ContentKind;
}

interface SelectedJsonRow {
  value: unknown;
  protected: boolean;
}

export function detectKind(content: string): ContentKind {
  try {
    JSON.parse(content);
    return "json";
  } catch {
    // Fall through to text heuristics.
  }
  if (/^diff --git /m.test(content) || /^@@ -\d+/m.test(content)) return "diff";
  const lines = content.split("\n");
  const logLines = lines.filter((line) => TIMESTAMP_PATTERN.test(line) || /\b(?:ERROR|WARN|INFO|DEBUG|FATAL)\b/.test(line));
  if (lines.length >= 4 && logLines.length >= 3) return "log";
  if (CODE_PATTERN.test(content)) return "code";
  return "text";
}

export function compress(content: string, options: CompressOptions): Promise<CompressResult> {
  const kind = options.strategy && options.strategy !== "auto" ? options.strategy : detectKind(content);
  if (kind === "json") return compressJson(content, options);
  if (kind === "log") return compressLines(content, options, kind, "log-lines", selectLogLines);
  if (kind === "diff") return compressLines(content, options, kind, "diff-hunks", selectDiffLines);
  if (kind === "code") return compressLines(content, options, kind, "code-outline", selectCodeLines);
  return compressLines(content, options, kind, "text-sample", selectTextLines);
}

export function decodeLosslessTable(encoded: string): Array<Record<string, unknown>> {
  const [schemaLine, headerLine, ...rowLines] = encoded.split("\n");
  const match = schemaLine?.match(/^\[(\d+)\]\{(.+)\}$/);
  if (!match || !headerLine) throw new Error("Invalid lossless table encoding.");
  const schema = splitSchema(match[2]);
  const headers = parseCsvLine(headerLine);
  if (headers.length !== schema.length || headers.some((header, index) => header !== schema[index]?.name)) {
    throw new Error("Lossless table schema and header do not match.");
  }
  const expectedRows = Number(match[1]);
  if (rowLines.length !== expectedRows) throw new Error("Lossless table row count does not match its schema.");
  return rowLines.map((line) => {
    const cells = parseCsvLine(line);
    if (cells.length !== schema.length) throw new Error("Lossless table row has the wrong number of cells.");
    return Object.fromEntries(schema.map((column, index) => [column.name, decodeCell(cells[index] ?? "", column.types)]));
  });
}

async function compressJson(content: string, options: CompressOptions): Promise<CompressResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return unchanged(content, "json");
  }
  if (!Array.isArray(parsed) || parsed.length <= (options.minItems ?? DEFAULT_MIN_ITEMS)) {
    return unchanged(content, "json");
  }

  const originalTokens = estimateTokens(content);
  const targetKeep = clamp(options.targetKeep ?? DEFAULT_TARGET_KEEP, 0.01, 1);
  const minKeep = Math.max(1, Math.floor(options.minKeep ?? DEFAULT_MIN_KEEP));
  const selection = selectJsonRows(parsed, targetKeep, minKeep, options.queryContext);
  const keep = selection.map(({ value }) => value);
  const droppedItems = parsed.length - selection.length;
  if (droppedItems <= 0) return unchanged(content, "json");

  const lossless = encodeLosslessTable(parsed);
  const markerDraft = `<<ccr:${"0".repeat(24)} ${droppedItems}_rows_offloaded>>`;
  const lossyDraft = JSON.stringify([...keep, { _ccr_dropped: markerDraft }]);
  if (
    options.preferLossless !== false &&
    lossless &&
    estimateTokens(lossless) < estimateTokens(lossyDraft) &&
    estimateTokens(lossless) < originalTokens
  ) {
    return result(lossless, "json", "lossless-table", null, originalTokens, 0);
  }

  let selected = selection;
  const targetTokens = Math.floor(originalTokens * targetKeep);
  while (selected.length > minKeep && estimateTokens(JSON.stringify([...selected.map(({ value }) => value), { _ccr_dropped: markerDraft }])) > targetTokens) {
    const removableIndex = findLeastImportantRemovableIndex(selected, options.queryContext);
    if (removableIndex < 0) break;
    selected = selected.filter((_, index) => index !== removableIndex);
  }
  const finalDroppedItems = parsed.length - selected.length;
  const compressedBase = JSON.stringify(selected.map(({ value }) => value));
  return persistLossy(content, compressedBase, "json", "smart-crush", finalDroppedItems, "rows", options, originalTokens, parsed.length, selected.length, true);
}


async function compressLines(
  content: string,
  options: CompressOptions,
  kind: ContentKind,
  strategy: string,
  select: (lines: string[]) => string[],
): Promise<CompressResult> {
  const lines = content.split("\n");
  const selected = select(lines);
  const compressedBase = selected.join("\n");
  const droppedItems = Math.max(0, lines.length - selected.length);
  if (droppedItems === 0 || compressedBase.length >= content.length) return unchanged(content, kind);
  return persistLossy(content, compressedBase, kind, strategy, droppedItems, "lines", options, estimateTokens(content), lines.length, selected.length, false);
}

async function persistLossy(
  originalContent: string,
  compressedBase: string,
  kind: ContentKind,
  strategy: string,
  droppedItems: number,
  itemLabel: string,
  options: CompressOptions,
  originalTokens: number,
  originalItemCount: number,
  compressedItemCount: number,
  jsonMarker: boolean,
): Promise<CompressResult> {
  const entry = await options.store.storeCompressionEntry({
    userId: options.userId,
    originalContent,
    compressedContent: compressedBase,
    originalTokens,
    compressedTokens: estimateTokens(compressedBase),
    originalItemCount,
    compressedItemCount,
    toolName: options.toolName ?? null,
    queryContext: options.queryContext ?? null,
    compressionStrategy: strategy,
  });
  const marker = jsonMarker
    ? JSON.stringify({ _ccr_dropped: `<<ccr:${entry.hash} ${droppedItems}_rows_offloaded>>` })
    : `[${droppedItems} ${itemLabel} compressed. Retrieve: hash=${entry.hash}]`;
  const compressed = jsonMarker
    ? `${compressedBase.slice(0, -1)},${marker}]`
    : `${compressedBase}\n${marker}`;
  return result(compressed, kind, strategy, entry.hash, originalTokens, droppedItems);
}

function result(
  compressed: string,
  kind: ContentKind,
  strategy: string,
  hash: string | null,
  originalTokens: number,
  droppedItems: number,
): CompressResult {
  const compressedTokens = estimateTokens(compressed);
  const tokensSaved = Math.max(0, originalTokens - compressedTokens);
  return {
    compressed,
    kind,
    strategy,
    hash,
    originalTokens,
    compressedTokens,
    tokensSaved,
    savingsPercent: originalTokens === 0 ? 0 : Math.round((tokensSaved / originalTokens) * 100),
    droppedItems,
  };
}

function unchanged(content: string, kind: ContentKind): CompressResult {
  return result(content, kind, "none", null, estimateTokens(content), 0);
}

function selectJsonRows(
  rows: unknown[],
  targetKeep: number,
  minKeep: number,
  queryContext?: string,
): SelectedJsonRow[] {
  const total = clamp(Math.ceil(rows.length * targetKeep), minKeep, rows.length);
  const mandatory = mandatoryIndexes(rows);
  const selected = new Set<number>(mandatory);
  const firstCount = Math.min(Math.ceil(total * 0.3), rows.length);
  const lastCount = Math.min(Math.ceil(total * 0.15), Math.max(0, rows.length - firstCount));
  for (let index = 0; index < firstCount; index += 1) selected.add(index);
  for (let index = rows.length - lastCount; index < rows.length; index += 1) selected.add(index);

  const anchorIndexes = new Set<number>();
  for (let index = 0; index < firstCount; index += 1) anchorIndexes.add(index);
  for (let index = rows.length - lastCount; index < rows.length; index += 1) anchorIndexes.add(index);
  const candidates = rows.map((_, index) => index).filter((index) => !selected.has(index));
  const remaining = Math.max(0, total - selected.size);
  const ranked = rankByQueryOrDiversity(rows, candidates, queryContext, remaining);
  for (const index of ranked.slice(0, remaining)) selected.add(index);

  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => ({ value: rows[index]!, protected: mandatory.has(index) || anchorIndexes.has(index) }));
}

function mandatoryIndexes(rows: unknown[]): Set<number> {
  const indexes = new Set<number>();
  const numericValues = new Map<string, number[]>();
  rows.forEach((row) => {
    if (!isRecord(row)) return;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        const values = numericValues.get(key) ?? [];
        values.push(value);
        numericValues.set(key, values);
      }
    }
  });
  const thresholds = new Map<string, number>();
  for (const [key, values] of numericValues) {
    if (values.length < 2) continue;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    thresholds.set(key, mean + 2 * Math.sqrt(variance));
  }
  rows.forEach((row, index) => {
    if (ERROR_PATTERN.test(JSON.stringify(row))) indexes.add(index);
    if (!isRecord(row)) return;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "number" && value > (thresholds.get(key) ?? Number.POSITIVE_INFINITY)) {
        indexes.add(index);
      }
    }
  });
  return indexes;
}

function rankByQueryOrDiversity(rows: unknown[], candidates: number[], queryContext: string | undefined, take: number): number[] {
  const terms = new Set(queryContext?.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
  if (terms.size > 0) {
    return candidates
      .map((index) => ({ index, score: overlapScore(rows[index], terms) }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(({ index }) => index);
  }
  if (take >= candidates.length) return candidates;
  const ranked: number[] = [];
  const selected = new Set<number>();
  for (let slot = 0; slot < take; slot += 1) {
    const offset = take === 1
      ? Math.floor(candidates.length / 2)
      : Math.round((slot * (candidates.length - 1)) / (take - 1));
    const candidate = candidates[offset];
    if (candidate !== undefined && !selected.has(candidate)) {
      ranked.push(candidate);
      selected.add(candidate);
    }
  }
  return [...ranked, ...candidates.filter((candidate) => !selected.has(candidate))];
}

function overlapScore(value: unknown, terms: Set<string>): number {
  const textTerms = new Set(JSON.stringify(value).toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
  let score = 0;
  for (const term of terms) {
    if (textTerms.has(term)) score += 1;
  }
  return score;
}

function findLeastImportantRemovableIndex(
  selected: SelectedJsonRow[],
  queryContext?: string,
): number {
  const terms = new Set(queryContext?.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
  let leastIndex = -1;
  let leastScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < selected.length; index += 1) {
    const row = selected[index]!;
    if (row.protected) continue;
    const score = overlapScore(row.value, terms);
    if (score < leastScore) {
      leastScore = score;
      leastIndex = index;
    }
  }
  return leastIndex;
}

function selectLogLines(lines: string[]): string[] {
  const keep = new Set<number>([0, lines.length - 1]);
  lines.forEach((line, index) => {
    if (ERROR_PATTERN.test(line) || /^\s*at\s/.test(line)) keep.add(index);
  });
  return lines.filter((_, index) => keep.has(index));
}

function selectDiffLines(lines: string[]): string[] {
  const keep = new Set<number>();
  let files = 0;
  let hunks = 0;
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) {
      files += 1;
      hunks = 0;
    }
    if (files > 10) return;
    if (line.startsWith("@@ ")) hunks += 1;
    if (hunks <= 2 || line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) keep.add(index);
  });
  return lines.filter((_, index) => keep.has(index));
}

function selectCodeLines(lines: string[]): string[] {
  const keep = new Set<number>([0, lines.length - 1]);
  lines.forEach((line, index) => {
    if (/^\s*(?:import|export|class|interface|type|function|const|let|var|public|private|protected)\b/.test(line)) keep.add(index);
  });
  return lines.filter((_, index) => keep.has(index));
}

function selectTextLines(lines: string[]): string[] {
  const keep = new Set<number>();
  lines.slice(0, 5).forEach((_, index) => keep.add(index));
  lines.slice(-5).forEach((_, offset) => keep.add(lines.length - 5 + offset));
  const ranked = lines
    .map((line, index) => ({ index, score: new Set(line.toLowerCase().match(/[a-z0-9_]{5,}/g) ?? []).size }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 8);
  ranked.forEach(({ index }) => keep.add(index));
  return lines.filter((_, index) => keep.has(index));
}

function encodeLosslessTable(rows: unknown[]): string | null {
  if (!rows.every(isRecord) || rows.length === 0) return null;
  const keys = Object.keys(rows[0]!);
  if (keys.length === 0 || keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) return null;
  if (!rows.every((row) => sameKeys(Object.keys(row), keys))) return null;
  const types = keys.map((key) => new Set(rows.map((row) => cellType(row[key]))));
  const schema = keys.map((key, index) => `${key}:${[...types[index]!].sort().join("|")}`).join(",");
  const header = keys.join(",");
  const body = rows.map((row) => keys.map((key) => encodeCell(row[key])).join(",")).join("\n");
  return `[${rows.length}]{${schema}}\n${header}\n${body}`;
}

function splitSchema(schema: string): Array<{ name: string; types: string[] }> {
  return schema.split(",").map((item) => {
    const separator = item.indexOf(":");
    if (separator <= 0) throw new Error("Invalid lossless table schema.");
    return { name: item.slice(0, separator), types: item.slice(separator + 1).split("|") };
  });
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quoted && character === '"' && line[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("Invalid quoted CSV cell.");
  cells.push(cell);
  return cells;
}

function encodeCell(value: unknown): string {
  if (value === null) return "";
  const text = cellType(value) === "json" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function decodeCell(value: string, types: string[]): unknown {
  if (value === "" && types.includes("null")) return null;
  if (types.length === 1 && types[0] === "number") return Number(value);
  if (types.length === 1 && types[0] === "boolean") return value === "true";
  if (types.length === 1 && types[0] === "json") return JSON.parse(value);
  return value;
}

function cellType(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "json";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

import { getCliKnobs } from '../config/config.js';

export interface ToolCompactionInput {
  toolName: string;
  args?: Record<string, unknown>;
  output: string;
}

export interface ToolCompactionResult {
  inlineText: string;
  omittedChars: number;
  ruleId: string;
  confidence: number;
  requiresResultHandoff?: boolean;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const PROGRESS_RE = /\b(\d+%|ETA|Progress|Downloading|Installing|added \d+ packages|audited \d+ packages)\b/i;
const PATH_RE = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+|\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|rs|py|go|java|css|scss)\b/g;
const ERROR_RE = /\b(error|failed|failure|exception|traceback|expected|received|not found|cannot|denied|timeout|timed out|warning)\b/i;

function contextCompactionEnabled(): boolean {
  return getCliKnobs().contextCompaction;
}

function oneLine(text: string): string {
  return text.replace(ANSI_RE, '').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function compactJson(text: string): ToolCompactionResult | undefined {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) && (!parsed || typeof parsed !== 'object')) return undefined;
    const compact = JSON.stringify(parsed, null, 2);
    if (compact.length <= 2500) return undefined;
    const keys = Array.isArray(parsed)
      ? [`array length=${parsed.length}`]
      : Object.keys(parsed).slice(0, 20).map((k) => `${k}: ${typeof parsed[k]}`);
    const inlineText = [
      '[compacted json]',
      ...keys.map((k) => `- ${k}`),
      `…raw JSON omitted (${compact.length} chars); full output is in transcript.`,
    ].join('\n');
    return {
      inlineText,
      omittedChars: Math.max(0, text.length - inlineText.length),
      ruleId: 'json-summary',
      confidence: 0.75,
    };
  } catch {
    return undefined;
  }
}

function compactCommandLike(input: ToolCompactionInput): ToolCompactionResult | undefined {
  const clean = oneLine(input.output);
  if (clean.length <= 2500) return undefined;
  const lines = clean.split('\n').map((line) => line.trim()).filter(Boolean);
  const signalLines = lines.filter((line) => ERROR_RE.test(line) || PATH_RE.test(line));
  const paths = unique(lines.flatMap((line) => line.match(PATH_RE) ?? [])).slice(0, 20);
  const progressDropped = lines.filter((line) => PROGRESS_RE.test(line)).length;
  const selected = unique(signalLines).slice(0, 80);
  if (selected.length === 0 && paths.length === 0) return undefined;

  const command = typeof input.args?.command === 'string' ? input.args.command : input.toolName;
  const inlineText = [
    `[compacted tool output: ${command}]`,
    progressDropped ? `Progress/noise lines dropped: ${progressDropped}` : '',
    paths.length ? `Paths: ${paths.join(', ')}` : '',
    selected.length ? 'Signal:' : '',
    ...selected.map((line) => `- ${line.length > 220 ? `${line.slice(0, 219)}…` : line}`),
    `…${Math.max(0, input.output.length - selected.join('\n').length)} chars omitted; full output is in transcript.`,
  ].filter(Boolean).join('\n');

  return {
    inlineText,
    omittedChars: Math.max(0, input.output.length - inlineText.length),
    ruleId: 'command-signal-lines',
    confidence: 0.8,
  };
}

function smartJsonArray(input: ToolCompactionInput): ToolCompactionResult | undefined {
  const knobs = getCliKnobs();
  if (!knobs.toolOutputCompressionEnabled || input.output.length < knobs.toolOutputCompressionMinChars) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length <= 20) return undefined;

  const target = Math.max(8, Math.min(parsed.length, Math.ceil(parsed.length * knobs.toolOutputCompressionTargetKeep)));
  const mandatory = mandatoryIndexes(parsed);
  const selected = new Set<number>(mandatory);
  const firstCount = Math.min(parsed.length, Math.ceil(target * 0.3));
  const lastCount = Math.min(parsed.length - firstCount, Math.ceil(target * 0.15));
  for (let index = 0; index < firstCount; index += 1) selected.add(index);
  for (let index = parsed.length - lastCount; index < parsed.length; index += 1) selected.add(index);

  const remaining = Math.max(0, target - selected.size);
  const candidates = parsed.map((_, index) => index).filter((index) => !selected.has(index));
  const query = typeof input.args?.query === 'string' ? input.args.query : '';
  for (const index of rankCandidates(parsed, candidates, query, remaining).slice(0, remaining)) selected.add(index);
  const rows = [...selected].sort((left, right) => left - right).map((index) => parsed[index]);
  const dropped = parsed.length - rows.length;
  if (dropped <= 0) return undefined;
  const inlineText = JSON.stringify([...rows, { _result_dropped: `${dropped} rows omitted; use extract_result with resultRef` }]);
  if (inlineText.length >= input.output.length) return undefined;
  return {
    inlineText,
    omittedChars: input.output.length - inlineText.length,
    ruleId: 'smart-json-array',
    confidence: 0.9,
    requiresResultHandoff: true,
  };
}

function mandatoryIndexes(rows: unknown[]): Set<number> {
  const mandatory = new Set<number>();
  const valuesByKey = new Map<string, number[]>();
  rows.forEach((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        const values = valuesByKey.get(key) ?? [];
        values.push(value);
        valuesByKey.set(key, values);
      }
    }
  });
  const thresholds = new Map<string, number>();
  for (const [key, values] of valuesByKey) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    thresholds.set(key, mean + 2 * deviation);
  }
  rows.forEach((row, index) => {
    if (ERROR_RE.test(JSON.stringify(row))) mandatory.add(index);
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'number' && value > (thresholds.get(key) ?? Number.POSITIVE_INFINITY)) mandatory.add(index);
    }
  });
  return mandatory;
}

function rankCandidates(rows: unknown[], candidates: number[], query: string, take: number): number[] {
  const terms = new Set(query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
  if (terms.size > 0) {
    return candidates
      .map((index) => ({ index, score: overlapScore(rows[index], terms) }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map(({ index }) => index);
  }
  if (take >= candidates.length) return candidates;
  const sampled: number[] = [];
  const seen = new Set<number>();
  for (let slot = 0; slot < take; slot += 1) {
    const offset = take === 1
      ? Math.floor(candidates.length / 2)
      : Math.round((slot * (candidates.length - 1)) / (take - 1));
    const candidate = candidates[offset];
    if (candidate !== undefined && !seen.has(candidate)) {
      sampled.push(candidate);
      seen.add(candidate);
    }
  }
  return [...sampled, ...candidates.filter((candidate) => !seen.has(candidate))];
}

function overlapScore(value: unknown, terms: Set<string>): number {
  const itemTerms = new Set(JSON.stringify(value).toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
  let score = 0;
  for (const term of terms) if (itemTerms.has(term)) score += 1;
  return score;
}

export function compactToolOutput(input: ToolCompactionInput): ToolCompactionResult {
  const smart = smartJsonArray(input);
  if (smart) return smart;
  if (!contextCompactionEnabled()) {
    return { inlineText: input.output, omittedChars: 0, ruleId: 'disabled', confidence: 1 };
  }
  const json = compactJson(input.output);
  if (json) return json;
  const command = compactCommandLike(input);
  if (command) return command;
  return { inlineText: input.output, omittedChars: 0, ruleId: 'passthrough', confidence: 1 };
}

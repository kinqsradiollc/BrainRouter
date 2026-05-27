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
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const PROGRESS_RE = /\b(\d+%|ETA|Progress|Downloading|Installing|added \d+ packages|audited \d+ packages)\b/i;
const PATH_RE = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+|\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|rs|py|go|java|css|scss)\b/g;
const ERROR_RE = /\b(error|failed|failure|exception|traceback|expected|received|not found|cannot|denied|timeout|timed out|warning)\b/i;

function enabled(): boolean {
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

export function compactToolOutput(input: ToolCompactionInput): ToolCompactionResult {
  if (!enabled()) {
    return { inlineText: input.output, omittedChars: 0, ruleId: 'disabled', confidence: 1 };
  }
  const json = compactJson(input.output);
  if (json) return json;
  const command = compactCommandLike(input);
  if (command) return command;
  return { inlineText: input.output, omittedChars: 0, ruleId: 'passthrough', confidence: 1 };
}

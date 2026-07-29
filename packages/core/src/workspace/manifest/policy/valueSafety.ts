/**
 * Workspace-manifest value safety and normalization primitives.
 *
 * A25-5d2: owns deterministic traversal budgets, collection bounds, secret and
 * local-path rejection, forward-compatible extra sanitization, and safe
 * instruction pointers independently of profile-default policy.
 */
import path from 'node:path';
import {
  WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES,
  WORKSPACE_MANIFEST_MAX_EXTRA_DEPTH,
  WORKSPACE_MANIFEST_MAX_NORMALIZATION_NODES,
} from '../contracts.js';
import {
  hasControlCharacters,
  isBoundedString,
  isLocalAbsolutePath,
  isSafeExtraKey,
  isSensitiveValue,
  stripControlCharacters,
} from './sensitiveValues.js';

export interface NormalizationBudget {
  remaining: number;
}

const KNOWN_KEYS = new Set([
  'version',
  'name',
  'profile',
  'planning',
  'onboarded',
  'persona',
  'orchestration',
  'agents',
  'capabilities',
  'skills',
  'tools',
  'memory',
  'instructions',
]);
export function createNormalizationBudget(): NormalizationBudget {
  return { remaining: WORKSPACE_MANIFEST_MAX_NORMALIZATION_NODES };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].slice(
    0,
    WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES,
  );
}

export function appendRequiredString(
  values: string[],
  required: string | undefined,
): string[] {
  if (!required || values.includes(required)) return values;
  if (values.length >= WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES) values.pop();
  values.push(required);
  return values;
}

export function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isInteger(value) && (value as number) >= minimum &&
    (value as number) <= maximum
    ? value as number
    : fallback;
}

export function collectExtraEntries(
  source: Record<string, unknown>,
  output: Record<string, unknown>,
  budget: NormalizationBudget,
  state: { inspected: number },
  skipExplicitExtra = false,
): void {
  for (const key in source) {
    if (!Object.hasOwn(source, key)) continue;
    if (state.inspected >= WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES ||
        !takeNode(budget)) {
      return;
    }
    state.inspected += 1;
    if (KNOWN_KEYS.has(key) || (skipExplicitExtra && key === 'extra') ||
        !isSafeExtraKey(key)) {
      continue;
    }
    const sanitized = sanitizeExtraValue(source[key], 0, budget, true);
    if (sanitized !== undefined) output[key] = sanitized;
  }
}

export function safeKnownString(
  value: unknown,
  fallback: string,
  budget: NormalizationBudget,
): string {
  const input = boundedInputString(value, budget);
  if (input === undefined) return fallback;
  const text = stripControlCharacters(input);
  return isSensitiveValue(text) || isLocalAbsolutePath(text) ? fallback : text;
}

export function safeStringArray(
  value: unknown,
  budget: NormalizationBudget,
): string[] {
  if (!Array.isArray(value)) return [];
  const output: string[] = [];
  const limit = Math.min(
    value.length,
    WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES,
  );
  for (let index = 0; index < limit && budget.remaining > 0; index += 1) {
    const sanitized = safeKnownString(value[index], '', budget);
    if (sanitized !== '') output.push(sanitized);
  }
  return output;
}

export function boundedInputString(
  value: unknown,
  budget: NormalizationBudget,
): string | undefined {
  if (!takeNode(budget) || typeof value !== 'string' ||
      !isBoundedString(value)) {
    return undefined;
  }
  return value;
}

export function safeInstructionPointer(
  value: unknown,
  budget: NormalizationBudget,
): string {
  const input = boundedInputString(value, budget);
  if (input === undefined) return 'AGENT.md';
  if (input.trim() === '') return '';
  if (hasControlCharacters(input)) return 'AGENT.md';
  const text = stripControlCharacters(input);
  const pointer = (
    isSensitiveValue(text) || isLocalAbsolutePath(text)
      ? 'AGENT.md'
      : text
  ).trim();
  if (!pointer || pointer.includes('\0') || pointer.includes('\n') ||
      pointer.includes('\r')) {
    return 'AGENT.md';
  }
  const normalized = path.posix.normalize(pointer.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) return 'AGENT.md';
  return normalized;
}

function sanitizeExtraValue(
  value: unknown,
  depth: number,
  budget: NormalizationBudget,
  alreadyCounted = false,
): unknown | undefined {
  if (depth > WORKSPACE_MANIFEST_MAX_EXTRA_DEPTH ||
      (!alreadyCounted && !takeNode(budget))) {
    return undefined;
  }
  if (typeof value === 'string') {
    if (!isBoundedString(value)) return undefined;
    const text = stripControlCharacters(value);
    return isSensitiveValue(text) || isLocalAbsolutePath(text)
      ? undefined
      : text;
  }
  if (value === null || typeof value === 'number' ||
      typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    const limit = Math.min(
      value.length,
      WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES,
    );
    for (let index = 0; index < limit && budget.remaining > 0; index += 1) {
      const sanitized = sanitizeExtraValue(value[index], depth + 1, budget);
      if (sanitized !== undefined) output.push(sanitized);
    }
    return output;
  }
  if (typeof value !== 'object') return undefined;

  const output: Record<string, unknown> = {};
  let inspected = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.hasOwn(value, key)) continue;
    if (inspected >= WORKSPACE_MANIFEST_MAX_COLLECTION_ENTRIES ||
        !takeNode(budget)) {
      break;
    }
    inspected += 1;
    if (!isSafeExtraKey(key)) continue;
    const sanitized = sanitizeExtraValue(
      (value as Record<string, unknown>)[key],
      depth + 1,
      budget,
      true,
    );
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function takeNode(budget: NormalizationBudget): boolean {
  if (budget.remaining <= 0) return false;
  budget.remaining -= 1;
  return true;
}

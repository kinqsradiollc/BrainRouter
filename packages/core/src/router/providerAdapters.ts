import type { ModelReasoningEffort } from '@kinqs/brainrouter-types';

/** Canonical effort -> one or more exact upstream object paths and values. */
export type ModelEffortWireMap = Partial<
  Record<ModelReasoningEffort, Readonly<Record<string, string>>>
>;

export class ModelEffortAdapterError extends Error {
  readonly code = 'INVALID_MODEL_EFFORT_ADAPTER';

  constructor(message: string) {
    super(message);
    this.name = 'ModelEffortAdapterError';
  }
}

const SAFE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parsePath(path: string): readonly string[] {
  if (!path || path !== path.trim()) {
    throw new ModelEffortAdapterError('Effort adapter path must be a non-empty canonical path.');
  }
  const segments = path.split('.');
  if (segments.some((segment) => !SAFE_SEGMENT.test(segment) || UNSAFE_SEGMENTS.has(segment))) {
    throw new ModelEffortAdapterError(`Effort adapter path is unsafe: ${path || '(empty)'}.`);
  }
  return segments;
}

function assertNoPathCollisions(paths: readonly string[]): void {
  const ordered = [...paths].sort();
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.startsWith(`${ordered[index - 1]}.`)) {
      throw new ModelEffortAdapterError(
        `Effort adapter paths conflict: ${ordered[index - 1]} and ${ordered[index]}.`,
      );
    }
  }
}

function setImmutable(
  payload: Readonly<Record<string, unknown>>,
  segments: readonly string[],
  value: string,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...payload };
  let source: Readonly<Record<string, unknown>> = payload;
  let destination = output;

  for (const segment of segments.slice(0, -1)) {
    const existing = Object.hasOwn(source, segment) ? source[segment] : undefined;
    if (existing !== undefined && !isRecord(existing)) {
      throw new ModelEffortAdapterError(
        `Effort adapter path traverses a non-object field: ${segments.join('.')}.`,
      );
    }
    const sourceChild = existing ?? {};
    const destinationChild = { ...sourceChild };
    destination[segment] = destinationChild;
    source = sourceChild;
    destination = destinationChild;
  }

  destination[segments.at(-1)!] = value;
  return output;
}

/**
 * Apply the selected canonical effort exactly as configured. Values are never
 * inferred, capped, or collapsed, and the caller's payload is never mutated.
 */
export function applyModelEffortWireMap(
  payload: Readonly<Record<string, unknown>>,
  effort: ModelReasoningEffort,
  wireMap: ModelEffortWireMap,
): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new ModelEffortAdapterError('The upstream payload must be a plain object.');
  }
  const targets = wireMap[effort];
  if (!targets || Object.keys(targets).length === 0) {
    throw new ModelEffortAdapterError(`Missing effort wire mapping for ${effort}.`);
  }

  const entries = Object.entries(targets);
  const parsed = entries.map(([path, value]) => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ModelEffortAdapterError(`Effort adapter path ${path || '(empty)'} requires an exact string value.`);
    }
    return { path, segments: parsePath(path), value };
  });
  assertNoPathCollisions(parsed.map(({ path }) => path));

  return parsed.reduce<Record<string, unknown>>(
    (result, target) => setImmutable(result, target.segments, target.value),
    payload as Record<string, unknown>,
  );
}


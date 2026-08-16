/**
 * ADR-040 A40-2 — synchronous Desktop-host capture for reviewed launches.
 *
 * The caller retains its request object while the host may cross async session
 * and Agent initialization boundaries. Copy only plain data descriptors before
 * the first await so accessors never execute and later caller mutation cannot
 * change the prompt or arguments that Core reviews and authorizes.
 */

const MAX_DEPTH = 24;
const MAX_NODES = 10_000;
const MAX_STRING_LENGTH = 256_000;
const MAX_TOTAL_STRING_CHARS = 1_000_000;
const MAX_OPAQUE_ID_LENGTH = 128;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type PlainData = string | number | boolean | null | PlainData[] | { [key: string]: PlainData };

export type ReviewedExecutionToolName = 'run_workflow' | 'run_workflow_graph';

export interface ReviewedExecutionRequest {
  prompt: string;
  toolName: ReviewedExecutionToolName;
  args: Record<string, unknown>;
  requestId?: string;
}

export interface CapturedReviewedExecutionRequest {
  readonly prompt: string;
  readonly toolName: ReviewedExecutionToolName;
  readonly args: Readonly<Record<string, unknown>>;
  readonly requestId?: string;
}

function snapshotPlainData(
  value: unknown,
  initialStringChars = 0,
): { value: PlainData; totalStringChars: number } {
  let nodes = 0;
  let totalStringChars = initialStringChars;
  const visit = (input: unknown, depth: number, label: string): PlainData => {
    nodes += 1;
    if (nodes > MAX_NODES) throw new Error('arguments exceed the structural size limit');
    if (depth > MAX_DEPTH) throw new Error('arguments exceed the nesting limit');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      if (input.length > MAX_STRING_LENGTH) throw new Error(`${label} exceeds ${MAX_STRING_LENGTH} characters`);
      totalStringChars += input.length;
      if (totalStringChars > MAX_TOTAL_STRING_CHARS) {
        throw new Error('reviewed request exceeds the cumulative string-size limit');
      }
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error(`${label} must be a finite number`);
      return input;
    }
    if (typeof input !== 'object') throw new Error(`${label} must contain JSON-compatible data`);

    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Array.isArray(input)) {
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !('value' in lengthDescriptor)) {
        throw new Error(`${label}.length must be a plain data property`);
      }
      const length = lengthDescriptor.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_NODES) {
        throw new Error(`${label} exceeds the structural size limit`);
      }
      const output: PlainData[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) {
          throw new Error(`${label}[${index}] must be a plain data property`);
        }
        output.push(visit(descriptor.value, depth + 1, `${label}[${index}]`));
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === 'length' || (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < length)) continue;
        throw new Error(`${label} contains an unsupported array property`);
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must be a plain object`);
    }
    const output: Record<string, PlainData> = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new Error(`${label} must not contain symbol properties`);
      if (key.length > MAX_STRING_LENGTH) {
        throw new Error(`${label} contains an object key that exceeds ${MAX_STRING_LENGTH} characters`);
      }
      totalStringChars += key.length;
      if (totalStringChars > MAX_TOTAL_STRING_CHARS) {
        throw new Error('reviewed request exceeds the cumulative string-size limit');
      }
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable) continue;
      if (!('value' in descriptor)) throw new Error(`${label}.${key} must not be an accessor`);
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${label}.${key} is not allowed`);
      }
      output[key] = visit(descriptor.value, depth + 1, `${label}.${key}`);
    }
    return output;
  };
  return {
    value: visit(value, 0, 'args'),
    totalStringChars,
  };
}

function dataDescriptor(
  descriptors: PropertyDescriptorMap,
  key: keyof ReviewedExecutionRequest,
  required: boolean,
): unknown {
  const descriptor = descriptors[key];
  if (!descriptor) {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (!('value' in descriptor)) throw new Error(`${key} must not be an accessor`);
  return descriptor.value;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function captureReviewedExecutionRequest(
  request: ReviewedExecutionRequest,
): CapturedReviewedExecutionRequest {
  if (!request || typeof request !== 'object') throw new Error('request must be a plain object');
  const prototype = Object.getPrototypeOf(request);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('request must be a plain object');
  const descriptors = Object.getOwnPropertyDescriptors(request);
  const allowed = new Set<PropertyKey>(['prompt', 'toolName', 'args', 'requestId']);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (!allowed.has(key)) throw new Error('request contains an unsupported property');
  }

  const prompt = dataDescriptor(descriptors, 'prompt', true);
  if (typeof prompt !== 'string') throw new Error('prompt must be a string');
  if (prompt.length > MAX_STRING_LENGTH) throw new Error(`prompt exceeds ${MAX_STRING_LENGTH} characters`);

  const toolName = dataDescriptor(descriptors, 'toolName', true);
  if (toolName !== 'run_workflow' && toolName !== 'run_workflow_graph') {
    throw new Error('toolName must identify a durable execution tool');
  }

  const argsSnapshot = snapshotPlainData(
    dataDescriptor(descriptors, 'args', true),
    prompt.length,
  );
  const args = argsSnapshot.value;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args must be a plain object');

  const requestId = dataDescriptor(descriptors, 'requestId', false);
  if (requestId !== undefined && typeof requestId !== 'string') throw new Error('requestId must be a string');
  if (typeof requestId === 'string' && (
    requestId.length > MAX_OPAQUE_ID_LENGTH
    || !OPAQUE_ID_PATTERN.test(requestId)
  )) {
    throw new Error('requestId must be an opaque ID of at most 128 safe characters');
  }
  if (argsSnapshot.totalStringChars + (requestId?.length ?? 0) > MAX_TOTAL_STRING_CHARS) {
    throw new Error('reviewed request exceeds the cumulative string-size limit');
  }

  return Object.freeze({
    prompt,
    toolName,
    args: deepFreeze(args),
    ...(requestId !== undefined ? { requestId } : {}),
  });
}

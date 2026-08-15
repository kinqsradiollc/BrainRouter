import { createHash } from 'node:crypto';
import type {
  ExecutionIntentTargetV1,
  PhasePlanExecutionIntentTargetV1,
  WorkflowGraphExecutionIntentTargetV1,
} from '@kinqs/brainrouter-types/agent';
import { normalizeReviewedPhasePlan, type PhasePlan } from '../workflow/phasePlan.js';
import { buildTemplatePlan } from '../../workflow/template/workflowTemplates.js';
import { validateGraph, type WorkflowGraph } from '../../workflow/graph/graph.js';

const MAX_DEPTH = 24;
const MAX_NODES = 10_000;
const MAX_STRING_LENGTH = 256_000;
const MAX_TOTAL_STRING_CHARS = 1_000_000;
const MAX_SLUG_LENGTH = 48;

type JsonScalar = string | number | boolean | null;
type PlainData = JsonScalar | PlainData[] | { [key: string]: PlainData };

export interface NormalizedExecutionIntentTarget {
  readonly record: ExecutionIntentTargetV1;
}

interface NormalizedTargetSnapshot {
  record: ExecutionIntentTargetV1;
  dispatchArgs: Readonly<Record<string, unknown>>;
  comparisonKey: string;
  phasePlan?: PhasePlan;
}

export type NormalizeExecutionTargetResult =
  | { ok: true; target: NormalizedExecutionIntentTarget }
  | { ok: false; errors: string[] };

const normalizedTargetSnapshots = new WeakMap<object, NormalizedTargetSnapshot>();

function fail(...errors: string[]): NormalizeExecutionTargetResult {
  return { ok: false, errors };
}

function boundedString(value: unknown, label: string, max = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return text;
}

function snapshotPlainData(value: unknown): PlainData {
  let nodes = 0;
  let totalStringChars = 0;
  const visit = (input: unknown, depth: number, label: string): PlainData => {
    nodes += 1;
    if (nodes > MAX_NODES) throw new Error('execution input exceeds the structural size limit');
    if (depth > MAX_DEPTH) throw new Error('execution input exceeds the nesting limit');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') {
      if (input.length > MAX_STRING_LENGTH) {
        throw new Error(`${label} exceeds ${MAX_STRING_LENGTH} characters`);
      }
      totalStringChars += input.length;
      if (totalStringChars > MAX_TOTAL_STRING_CHARS) {
        throw new Error('execution input exceeds the cumulative string-size limit');
      }
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error(`${label} must be a finite number`);
      return input;
    }
    if (typeof input !== 'object') throw new Error(`${label} must contain JSON-compatible data`);

    if (Array.isArray(input)) {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const output: PlainData[] = [];
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) {
          throw new Error(`${label}[${index}] must be a plain data property`);
        }
        output.push(visit(descriptor.value, depth + 1, `${label}[${index}]`));
      }
      for (const key of Object.keys(descriptors)) {
        if (key === 'length' || /^\d+$/.test(key)) continue;
        throw new Error(`${label}.${key} is not allowed on an array`);
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must be a plain object`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const output: Record<string, PlainData> = {};
    for (const key of Object.keys(descriptors).sort()) {
      if (key.length > MAX_STRING_LENGTH) {
        throw new Error(`${label} contains an object key that exceeds ${MAX_STRING_LENGTH} characters`);
      }
      totalStringChars += key.length;
      if (totalStringChars > MAX_TOTAL_STRING_CHARS) {
        throw new Error('execution input exceeds the cumulative string-size limit');
      }
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable) continue;
      if (!('value' in descriptor)) {
        throw new Error(`${label}.${key} must not be an accessor`);
      }
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`${label}.${key} is not allowed`);
      }
      output[key] = visit(descriptor.value, depth + 1, `${label}.${key}`);
    }
    return output;
  };
  return visit(value, 0, 'execution input');
}

/**
 * Take a descriptor-safe, immutable copy before an async host boundary. Kept
 * out of the public execution barrel: this is an authority implementation
 * primitive, not a serializable bearer or a general cloning API.
 */
export function snapshotExecutionIntentInput(value: unknown): unknown {
  return deepFreeze(snapshotPlainData(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function workflowSlug(raw: unknown, plan: PhasePlan): string {
  const source = (
    typeof raw === 'string' && raw.trim()
      ? raw.trim()
      : plan.title?.trim() || 'workflow'
  );
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
  return slug || 'workflow';
}

function mintNormalizedTarget(
  record: ExecutionIntentTargetV1,
  dispatchArgs: Record<string, unknown>,
  phasePlan?: PhasePlan,
): NormalizedExecutionIntentTarget {
  const frozenRecord = deepFreeze(structuredClone(record));
  const frozenArgs = deepFreeze(structuredClone(dispatchArgs));
  const frozenPhasePlan = phasePlan
    ? deepFreeze(structuredClone(phasePlan))
    : undefined;
  const target = Object.freeze({ record: frozenRecord });
  normalizedTargetSnapshots.set(target, {
    record: frozenRecord,
    dispatchArgs: frozenArgs,
    comparisonKey: canonicalJson(frozenRecord),
    ...(frozenPhasePlan ? { phasePlan: frozenPhasePlan } : {}),
  });
  return target;
}

export function normalizedExecutionTargetSnapshot(
  value: unknown,
): NormalizedTargetSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  return normalizedTargetSnapshots.get(value) ?? null;
}

/** Internal eligibility view; never serialized into the content-free record. */
export function normalizedPhasePlanSnapshot(
  value: unknown,
): PhasePlan | null {
  if (!value || typeof value !== 'object') return null;
  return normalizedTargetSnapshots.get(value)?.phasePlan ?? null;
}

export function normalizePhasePlanExecutionTarget(
  raw: unknown,
): NormalizeExecutionTargetResult {
  try {
    const input = snapshotPlainData(raw);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return fail('workflow launch arguments must be an object');
    }
    const args = input as Record<string, PlainData>;
    const background = args.background === undefined ? false : args.background;
    if (typeof background !== 'boolean') return fail('background must be a boolean');
    if (background) {
      return fail(
        'trusted background phase runs are not enabled until durable execution owns a revocable authority lease beyond the launch turn',
      );
    }

    const resume = typeof args.resume === 'string' && args.resume.trim()
      ? boundedString(args.resume, 'resume', 128)
      : null;
    const template = typeof args.template === 'string' && args.template.trim()
      ? boundedString(args.template, 'template', 128)
      : null;
    const hasPlan = args.plan !== undefined;
    if (resume && (template || hasPlan)) {
      return fail('resume cannot be combined with plan or template');
    }
    if (template && hasPlan) return fail('plan and template are mutually exclusive');

    if (resume) {
      return fail(
        'trusted phase-run resume is not enabled until each resume attempt has durable execution lineage',
      );
    }

    let plan: PhasePlan | null = null;
    let errors: string[] = [];
    if (template) {
      const templateArgs = args.templateArgs === undefined
        ? {}
        : args.templateArgs;
      if (!templateArgs || typeof templateArgs !== 'object' || Array.isArray(templateArgs)) {
        return fail('templateArgs must be an object');
      }
      const built = buildTemplatePlan(template, templateArgs);
      if (built.plan) {
        const normalized = normalizeReviewedPhasePlan(built.plan);
        plan = normalized.plan;
        errors = normalized.errors;
      } else {
        plan = null;
        errors = built.errors;
      }
    } else {
      const normalized = normalizeReviewedPhasePlan(args.plan);
      plan = normalized.plan;
      errors = normalized.errors;
    }
    if (!plan) return fail(...(errors.length ? errors : ['a valid plan or template is required']));

    const slug = workflowSlug(args.slug, plan);
    const record: PhasePlanExecutionIntentTargetV1 = {
      topology: 'phase-plan',
      slug,
      background,
      resume: null,
      template,
      definitionDigest: digest(plan),
    };
    const dispatchArgs: Record<string, unknown> = template
      ? {
        template,
        templateArgs: args.templateArgs ?? {},
        ...(typeof args.slug === 'string' && args.slug.trim() ? { slug } : {}),
        ...(background ? { background: true } : {}),
      }
      : {
        plan,
        ...(typeof args.slug === 'string' && args.slug.trim() ? { slug } : {}),
        ...(background ? { background: true } : {}),
      };
    return {
      ok: true,
      target: mintNormalizedTarget(record, dispatchArgs, plan),
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export function normalizeWorkflowGraphExecutionTarget(
  raw: unknown,
): NormalizeExecutionTargetResult {
  try {
    const input = snapshotPlainData(raw);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return fail('workflow graph launch arguments must be an object');
    }
    const args = input as Record<string, PlainData>;
    const graphId = boundedString(args.graphId ?? args.id, 'graphId', 128);
    const graphRevision = args.graphRevision === undefined || args.graphRevision === null
      ? null
      : boundedString(args.graphRevision, 'graphRevision', 128);
    if (!args.definition || typeof args.definition !== 'object' || Array.isArray(args.definition)) {
      return fail('definition must be a workflow graph object');
    }
    const definition = args.definition as unknown as WorkflowGraph;
    const validation = validateGraph(definition);
    if (!validation.ok) return fail(...validation.errors);
    const vars = args.vars === undefined ? {} : args.vars;
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
      return fail('vars must be an object');
    }
    const record: WorkflowGraphExecutionIntentTargetV1 = {
      topology: 'workflow-graph',
      graphId,
      graphRevision,
      definitionDigest: digest({ definition, vars }),
    };
    return {
      ok: true,
      target: mintNormalizedTarget(record, {
        id: graphId,
        graphId,
        graphRevision,
        definition,
        vars,
      }),
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

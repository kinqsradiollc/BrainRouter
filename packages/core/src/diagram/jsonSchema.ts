/**
 * Published JSON Schema for the diagram IR (ADR-056 D-A1), derived from the
 * zod schemas so the two cannot drift. Consumers: the generated
 * `brainrouter-docs/generated/diagram-ir.md` (drift-checked), tool input
 * descriptions, and any external author who wants to validate before calling.
 */
import { z } from 'zod';
import { DIAGRAM_KINDS, type DiagramKind } from '@kinqs/brainrouter-types';
import { DIAGRAM_SCHEMAS } from './schema.js';

export type DiagramJsonSchema = Record<string, unknown>;

/** Draft 2020-12 JSON Schema for one kind; `additionalProperties: false` at every object level. */
export function diagramJsonSchema(kind: DiagramKind): DiagramJsonSchema {
  return z.toJSONSchema(DIAGRAM_SCHEMAS[kind], { target: 'draft-2020-12', unrepresentable: 'any' }) as DiagramJsonSchema;
}

/** Every kind's schema, keyed by kind, in catalogue order. */
export function diagramJsonSchemas(): Record<DiagramKind, DiagramJsonSchema> {
  const out = {} as Record<DiagramKind, DiagramJsonSchema>;
  for (const kind of DIAGRAM_KINDS) out[kind] = diagramJsonSchema(kind);
  return out;
}

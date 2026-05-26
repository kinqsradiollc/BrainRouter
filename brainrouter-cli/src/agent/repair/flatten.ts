/**
 * Schema flatten / re-nest (0.3.9 item 11.1).
 *
 * Empirical OpenAI-compatible LLM behavior: small / open / quantised
 * models (Gemma-2B, Phi-4, LM Studio gpt-oss) drop arguments when the
 * tool's JSON schema has >10 leaves or depth >2. Flattening to
 * dot-notation paths fixes that — the model emits flat key→value
 * pairs, and `nestArguments()` re-nests at dispatch time before the
 * tool implementation sees the args.
 *
 * Adapted from openSrc/DeepSeek-Reasonix/src/repair/flatten.ts.
 *
 * Why these thresholds:
 *   - leaves >10  — empirically the breaking point for arg-dropping.
 *   - depth >2    — small models conflate a.b.c with a_b_c and lose
 *                   the structure either way.
 *
 * Arrays are treated as leaves: re-nesting them from flat paths is
 * lossy if the model emits `arr.0`, `arr.1`, …, so we leave arrays
 * alone — the model sees them as opaque values.
 */

export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  [k: string]: unknown;
}

export interface FlattenDecision {
  shouldFlatten: boolean;
  leafCount: number;
  maxDepth: number;
}

/**
 * Walk the schema and decide whether flattening would help. Returns
 * the leaf count and max depth alongside the boolean so callers can
 * log "tool X auto-flattened (12 leaves, depth 3)".
 */
export function analyzeSchema(schema: JSONSchema | undefined): FlattenDecision {
  if (!schema) return { shouldFlatten: false, leafCount: 0, maxDepth: 0 };
  let leafCount = 0;
  let maxDepth = 0;
  walk(schema, 0, (depth, isLeaf) => {
    if (isLeaf) leafCount++;
    if (depth > maxDepth) maxDepth = depth;
  });
  return {
    shouldFlatten: leafCount > 10 || maxDepth > 2,
    leafCount,
    maxDepth,
  };
}

/**
 * Produce a flat dot-notation version of the schema. The flat schema
 * is what the model sees in its `tools` array; `nestArguments()`
 * reverses the flattening at dispatch time. Order of required fields
 * is preserved.
 */
export function flattenSchema(schema: JSONSchema): JSONSchema {
  const flatProps: Record<string, JSONSchema> = {};
  const required: string[] = [];
  collect('', schema, flatProps, required, true);
  return {
    type: 'object',
    properties: flatProps,
    required,
  };
}

/**
 * Re-nest a flat arguments object emitted against the flattened
 * schema. The complement of `flattenSchema()` — every dot becomes a
 * nested object boundary.
 */
export function nestArguments(flatArgs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flatArgs)) {
    setByPath(out, key.split('.'), value);
  }
  return out;
}

function walk(
  schema: JSONSchema,
  depth: number,
  visit: (depth: number, isLeaf: boolean) => void,
): void {
  if (schema.type === 'object' && schema.properties) {
    for (const child of Object.values(schema.properties)) {
      walk(child, depth + 1, visit);
    }
    return;
  }
  if (schema.type === 'array' && schema.items) {
    // Arrays are treated as leaves (see header note) — recurse for
    // depth counting but mark this position as a leaf.
    walk(schema.items, depth + 1, visit);
    return;
  }
  visit(depth, true);
}

function collect(
  prefix: string,
  schema: JSONSchema,
  out: Record<string, JSONSchema>,
  required: string[],
  isRootRequired: boolean,
): void {
  if (schema.type === 'object' && schema.properties) {
    const requiredSet = new Set(schema.required ?? []);
    for (const [key, child] of Object.entries(schema.properties)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      const childRequired = isRootRequired && requiredSet.has(key);
      collect(nextPrefix, child, out, required, childRequired);
    }
    return;
  }
  // Treat anything non-object (including arrays) as a leaf.
  out[prefix] = schema;
  if (isRootRequired) required.push(prefix);
}

function setByPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: any = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  cur[path[path.length - 1]!] = value;
}

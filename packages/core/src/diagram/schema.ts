/**
 * Diagram IR validation (ADR-056 D-A1).
 *
 * Two layers, one result. The STRUCTURAL layer is a strict zod schema per kind
 * (`z.strictObject` at every level, so an unknown field is rejected with its
 * path rather than silently ignored — the reason a typed document can be
 * trusted as the unit of storage, diff, and review). The SEMANTIC layer runs on
 * the parsed document: ids unique, every reference resolves, the main path is
 * a connected chain, a lifecycle has one initial state, and the quality
 * profile's primary-element cap. Diagnostics carry a stable `diagram/<slug>`
 * code, a JSON path, and the repairs the author may choose from; they are
 * sorted by path so two runs over the same document read identically.
 *
 * Why zod and not a JSON-schema validator: core already carries zod for its
 * other model-facing contracts, and `toJSONSchema` (jsonSchema.ts) derives the
 * published schema from the same source, so the two cannot drift.
 */
import { z } from 'zod';
import {
  DIAGRAM_SCHEMA_VERSION,
  DIAGRAM_KINDS,
  DIAGRAM_COMPONENT_TYPES,
  isDiagramKind,
  type Diagram,
  type DiagramDiagnostic,
  type DiagramKind,
  type DiagramRelation,
  type DiagramValidation,
} from '@kinqs/brainrouter-types';

/** Primary elements a `showcase` diagram may carry — one readable story, not a dump. */
export const DIAGRAM_SHOWCASE_MAX_PRIMARY = 12;

const ID = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'id must be alphanumeric with _ . : -');
const LABEL = z.string().min(1).max(200);
const DESCRIPTION = z.string().max(2_000);
const SHA = z.string().regex(/^[0-9a-f]{40}$/, 'revision must be a full 40-hex commit sha');
// Repo-relative POSIX only: no leading slash, no backslashes, no `..` segment, no control characters.
const REPO_PATH = z.string().min(1).max(512)
  .regex(/^(?![/\\])(?!.*\\)(?!(?:.*\/)?\.\.(?:\/|$))[^\x00-\x1f\x7f]+$/, 'path must be repo-relative POSIX without ".." segments');

const source = z.strictObject({
  path: REPO_PATH,
  lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
  revision: SHA.optional(),
});
const evidence = z.enum(['authored', 'verified', 'unverified']);
const element = {
  id: ID,
  label: LABEL,
  description: DESCRIPTION.optional(),
  sources: z.array(source).max(32).optional(),
  evidence: evidence.optional(),
};
const relation = { ...element, from: ID, to: ID };
const view = z.strictObject({ id: ID, label: LABEL, focus: z.array(ID).min(1).max(64), note: z.string().max(500).optional() });
const meta = z.strictObject({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional(),
  theme: z.enum(['auto', 'dark', 'light']).optional(),
  repository: z.strictObject({ url: z.string().max(500).optional(), revision: SHA.optional() }).optional(),
  qualityProfile: z.enum(['standard', 'showcase']).optional(),
  views: z.array(view).max(5).optional(),
});
const head = { schemaVersion: z.literal(DIAGRAM_SCHEMA_VERSION), meta };
const componentType = z.enum(DIAGRAM_COMPONENT_TYPES);

export const ArchitectureDiagramSchema = z.strictObject({
  ...head,
  kind: z.literal('architecture'),
  components: z.array(z.strictObject({
    ...element,
    type: componentType,
    variant: z.enum(['default', 'emphasis', 'security', 'dashed']).optional(),
    column: z.number().int().min(0).max(64).optional(),
    row: z.number().int().min(0).max(64).optional(),
  })).min(1).max(200),
  boundaries: z.array(z.strictObject({
    id: ID, label: LABEL, wraps: z.array(ID).min(1).max(200),
    kind: z.enum(['trust', 'network', 'region', 'group']).optional(),
  })).max(32).optional(),
  connections: z.array(z.strictObject({
    ...relation,
    style: z.enum(['sync', 'async', 'data']).optional(),
    direction: z.enum(['forward', 'both']).optional(),
  })).max(400),
  mainPath: z.array(ID).min(2).max(64).optional(),
});

export const WorkflowDiagramSchema = z.strictObject({
  ...head,
  kind: z.literal('workflow'),
  lanes: z.array(z.strictObject({ id: ID, label: LABEL })).max(16).optional(),
  nodes: z.array(z.strictObject({
    ...element,
    lane: ID.optional(),
    shape: z.enum(['step', 'decision', 'start', 'end', 'tool']).optional(),
  })).min(1).max(200),
  edges: z.array(z.strictObject(relation)).max(400),
  mainPath: z.array(ID).min(2).max(64).optional(),
});

export const SequenceDiagramSchema = z.strictObject({
  ...head,
  kind: z.literal('sequence'),
  participants: z.array(z.strictObject({ ...element, type: componentType.optional() })).min(1).max(32),
  messages: z.array(z.strictObject({ ...relation, kind: z.enum(['sync', 'async', 'return']).optional() })).min(1).max(400),
  activations: z.array(z.strictObject({ participant: ID, fromMessage: ID, toMessage: ID })).max(200).optional(),
});

export const DataflowDiagramSchema = z.strictObject({
  ...head,
  kind: z.literal('dataflow'),
  stages: z.array(z.strictObject({ id: ID, label: LABEL })).max(16).optional(),
  nodes: z.array(z.strictObject({ ...element, stage: ID.optional(), type: componentType.optional() })).min(1).max(200),
  flows: z.array(z.strictObject(relation)).max(400),
});

export const LifecycleDiagramSchema = z.strictObject({
  ...head,
  kind: z.literal('lifecycle'),
  states: z.array(z.strictObject({
    ...element,
    type: z.enum(['initial', 'active', 'waiting', 'terminal', 'failure']).optional(),
  })).min(1).max(100),
  transitions: z.array(z.strictObject(relation)).max(400),
});

export const DIAGRAM_SCHEMAS = {
  architecture: ArchitectureDiagramSchema,
  workflow: WorkflowDiagramSchema,
  sequence: SequenceDiagramSchema,
  dataflow: DataflowDiagramSchema,
  lifecycle: LifecycleDiagramSchema,
} as const;

/** `a.b[2].c` from a zod issue path. */
function jsonPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

function diag(code: string, severity: 'error' | 'warning', path: string, message: string, supportedFixes?: string[]): DiagramDiagnostic {
  return supportedFixes?.length ? { code, severity, path, message, supportedFixes } : { code, severity, path, message };
}

/** Sort by path, then severity (errors first), then code — a deterministic reading order. */
function sortDiagnostics(list: DiagramDiagnostic[]): DiagramDiagnostic[] {
  return [...list].sort((a, b) =>
    a.path.localeCompare(b.path)
    || (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1)
    || a.code.localeCompare(b.code));
}

interface Named { id: string }

/** Semantic checks over a structurally valid document. */
function semanticDiagnostics(doc: Diagram, quality: 'standard' | 'showcase'): DiagramDiagnostic[] {
  const out: DiagramDiagnostic[] = [];
  const ids = new Map<string, string>();
  const register = (arrayName: string, items: readonly Named[] | undefined) => {
    (items ?? []).forEach((it, i) => {
      const at = `${arrayName}[${i}].id`;
      const prev = ids.get(it.id);
      if (prev) out.push(diag('diagram/duplicate-id', 'error', at, `Duplicate id "${it.id}" (first declared at ${prev}).`, ['rename one of the elements so every id is unique']));
      else ids.set(it.id, at);
    });
  };
  const requireRef = (path: string, id: string, kindLabel: string, allowed?: Set<string>) => {
    if (!ids.has(id) || (allowed && !allowed.has(id))) {
      out.push(diag('diagram/unresolved-reference', 'error', path, `${kindLabel} "${id}" does not name a declared element.`, ['declare the element', 'point the reference at an existing id']));
      return false;
    }
    return true;
  };
  const checkRelations = (arrayName: string, rels: readonly DiagramRelation[], endpoints: Set<string>, selfLoopOk: boolean) => {
    rels.forEach((r, i) => {
      const okFrom = requireRef(`${arrayName}[${i}].from`, r.from, 'Source', endpoints);
      const okTo = requireRef(`${arrayName}[${i}].to`, r.to, 'Target', endpoints);
      if (okFrom && okTo && r.from === r.to && !selfLoopOk) {
        out.push(diag('diagram/self-loop', 'warning', `${arrayName}[${i}]`, `"${r.id}" connects "${r.from}" to itself; a self-relationship carries no topology.`, ['remove the relationship', 'describe the behaviour in the element description']));
      }
    });
  };
  const checkMainPath = (mainPath: string[] | undefined, endpoints: Set<string>, rels: readonly DiagramRelation[]) => {
    if (!mainPath) return;
    mainPath.forEach((id, i) => requireRef(`mainPath[${i}]`, id, 'Main-path element', endpoints));
    for (let i = 0; i + 1 < mainPath.length; i++) {
      const a = mainPath[i], b = mainPath[i + 1];
      if (!endpoints.has(a) || !endpoints.has(b)) continue;
      if (!rels.some((r) => (r.from === a && r.to === b) || (r.from === b && r.to === a))) {
        out.push(diag('diagram/main-path-broken', 'error', `mainPath[${i + 1}]`, `No relationship joins "${a}" to "${b}", so the main path is not a connected chain.`, ['add the missing relationship', 'reorder or shorten the main path']));
      }
    }
  };
  const checkViews = () => {
    (doc.meta.views ?? []).forEach((v, vi) => v.focus.forEach((id, fi) => requireRef(`meta.views[${vi}].focus[${fi}]`, id, 'View focus')));
  };
  const primaryCap = (arrayName: string, count: number) => {
    if (count > DIAGRAM_SHOWCASE_MAX_PRIMARY) {
      out.push(diag('diagram/too-many-primary', quality === 'showcase' ? 'error' : 'warning', arrayName,
        `${count} primary elements; a readable map carries at most ${DIAGRAM_SHOWCASE_MAX_PRIMARY}. Put supporting detail in descriptions instead of adding elements.`,
        ['merge elements that share a role', 'move detail into element descriptions', 'set meta.qualityProfile to "standard" for a dense map']));
    }
  };

  switch (doc.kind) {
    case 'architecture': {
      register('components', doc.components); register('boundaries', doc.boundaries); register('connections', doc.connections);
      const comps = new Set(doc.components.map((c) => c.id));
      (doc.boundaries ?? []).forEach((b, bi) => b.wraps.forEach((id, wi) => requireRef(`boundaries[${bi}].wraps[${wi}]`, id, 'Boundary member', comps)));
      checkRelations('connections', doc.connections, comps, false);
      checkMainPath(doc.mainPath, comps, doc.connections);
      primaryCap('components', doc.components.length);
      break;
    }
    case 'workflow': {
      register('lanes', doc.lanes); register('nodes', doc.nodes); register('edges', doc.edges);
      const nodes = new Set(doc.nodes.map((n) => n.id));
      const lanes = new Set((doc.lanes ?? []).map((l) => l.id));
      doc.nodes.forEach((n, i) => { if (n.lane !== undefined) requireRef(`nodes[${i}].lane`, n.lane, 'Lane', lanes); });
      checkRelations('edges', doc.edges, nodes, false);
      checkMainPath(doc.mainPath, nodes, doc.edges);
      primaryCap('nodes', doc.nodes.length);
      break;
    }
    case 'sequence': {
      register('participants', doc.participants); register('messages', doc.messages);
      const parts = new Set(doc.participants.map((p) => p.id));
      const msgs = new Set(doc.messages.map((m) => m.id));
      checkRelations('messages', doc.messages, parts, true);
      (doc.activations ?? []).forEach((a, i) => {
        requireRef(`activations[${i}].participant`, a.participant, 'Activation participant', parts);
        const okFrom = requireRef(`activations[${i}].fromMessage`, a.fromMessage, 'Activation start message', msgs);
        const okTo = requireRef(`activations[${i}].toMessage`, a.toMessage, 'Activation end message', msgs);
        if (okFrom && okTo) {
          const fi = doc.messages.findIndex((m) => m.id === a.fromMessage);
          const ti = doc.messages.findIndex((m) => m.id === a.toMessage);
          if (ti < fi) out.push(diag('diagram/activation-order', 'error', `activations[${i}]`, `Activation ends at "${a.toMessage}" before it starts at "${a.fromMessage}".`, ['swap fromMessage and toMessage']));
        }
      });
      primaryCap('participants', doc.participants.length);
      break;
    }
    case 'dataflow': {
      register('stages', doc.stages); register('nodes', doc.nodes); register('flows', doc.flows);
      const nodes = new Set(doc.nodes.map((n) => n.id));
      const stages = new Set((doc.stages ?? []).map((s) => s.id));
      doc.nodes.forEach((n, i) => { if (n.stage !== undefined) requireRef(`nodes[${i}].stage`, n.stage, 'Stage', stages); });
      checkRelations('flows', doc.flows, nodes, false);
      primaryCap('nodes', doc.nodes.length);
      break;
    }
    case 'lifecycle': {
      register('states', doc.states); register('transitions', doc.transitions);
      const states = new Set(doc.states.map((s) => s.id));
      checkRelations('transitions', doc.transitions, states, true);
      const initials = doc.states.filter((s) => s.type === 'initial');
      if (doc.states.some((s) => s.type) && initials.length !== 1) {
        out.push(diag('diagram/initial-state', 'error', 'states', `A typed lifecycle needs exactly one initial state; found ${initials.length}.`, ['mark exactly one state type: "initial"']));
      }
      doc.states.forEach((s, i) => {
        if (s.type === 'failure' && !doc.transitions.some((t) => t.from === s.id)) {
          out.push(diag('diagram/unrecoverable-failure', 'warning', `states[${i}]`, `Failure state "${s.id}" has no outgoing transition; if it is recoverable, add the transition back to the active state.`, ['add a recovery transition', 'type the state as terminal']));
        }
      });
      primaryCap('states', doc.states.length);
      break;
    }
  }
  checkViews();
  return out;
}

/**
 * Validate an untrusted document. Never throws. Structural failures stop before
 * the semantic pass (a document with unknown keys is not a document yet).
 */
export function validateDiagram(input: unknown, opts: { quality?: 'standard' | 'showcase' } = {}): DiagramValidation {
  const diagnostics: DiagramDiagnostic[] = [];
  const kindRaw = input && typeof input === 'object' ? (input as { kind?: unknown }).kind : undefined;
  if (!isDiagramKind(kindRaw)) {
    diagnostics.push(diag('diagram/unknown-kind', 'error', 'kind', `kind must be one of ${DIAGRAM_KINDS.join(', ')}.`, DIAGRAM_KINDS.map((k) => `set kind to "${k}"`)));
    return { ok: false, diagnostics, errorCount: 1, warningCount: 0 };
  }
  const kind: DiagramKind = kindRaw;
  const parsed = DIAGRAM_SCHEMAS[kind].safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = jsonPath(issue.path);
      if (issue.code === 'unrecognized_keys') {
        const keys = (issue as { keys?: string[] }).keys ?? [];
        const first = keys[0] ?? '?';
        diagnostics.push(diag('diagram/unknown-field', 'error', path ? `${path}.${first}` : first,
          `Unknown field${keys.length > 1 ? 's' : ''} ${keys.map((k) => `"${k}"`).join(', ')} — the schema rejects fields it does not define.`,
          ['remove the field', 'move the information into description']));
      } else {
        diagnostics.push(diag('diagram/invalid-field', 'error', path, issue.message));
      }
    }
    const sorted = sortDiagnostics(diagnostics);
    return { ok: false, kind, diagnostics: sorted, errorCount: sorted.length, warningCount: 0 };
  }
  const doc = parsed.data as Diagram;
  const quality = opts.quality ?? doc.meta.qualityProfile ?? 'showcase';
  const sorted = sortDiagnostics(semanticDiagnostics(doc, quality));
  const errorCount = sorted.filter((d) => d.severity === 'error').length;
  const warningCount = sorted.length - errorCount;
  const ok = errorCount === 0 && (quality !== 'showcase' || warningCount === 0);
  return ok
    ? { ok, kind, diagram: doc, diagnostics: sorted, errorCount, warningCount }
    : { ok, kind, diagnostics: sorted, errorCount, warningCount };
}

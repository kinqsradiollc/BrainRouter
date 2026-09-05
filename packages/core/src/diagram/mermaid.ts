/**
 * Mermaid is an input, not an output (ADR-056 D-A6).
 *
 * A `flowchart` / `graph` is read for what it SAYS — nodes, shapes, links,
 * link text, subgraphs — and a fresh workflow or architecture document is
 * authored from that. Styling (`style`, `classDef`, `class`, `linkStyle`,
 * `click`, init directives) is never transcribed: what Mermaid looked like is
 * not a fact about the system. Anything the grammar here does not cover is
 * dropped and REPORTED, never guessed. Bounded and deterministic.
 */
import type { ArchitectureDiagram, ArchitectureConnection, ArchitectureComponent, ArchitectureBoundary, DiagramRelation, WorkflowDiagram, WorkflowNode, WorkflowLane, DiagramComponentType, DiagramValidation } from '@kinqs/brainrouter-types';
import { DIAGRAM_SCHEMA_VERSION } from '@kinqs/brainrouter-types';
import { validateDiagram } from './schema.js';
import { inferComponentType } from './draft.js';

export const MERMAID_LIMITS = { chars: 64 * 1024, nodes: 60, edges: 120 } as const;

export interface MermaidImportOptions { kind?: 'workflow' | 'architecture'; title?: string }

export interface MermaidImport {
  diagram: WorkflowDiagram | ArchitectureDiagram;
  /** Why the document looks the way it does — kind chosen, direction ignored, nested groups flattened. */
  notes: string[];
  /** Source lines that were not transcribed (styling, classes, clicks, unsupported syntax). */
  dropped: string[];
  validation: DiagramValidation;
}

type Shape = 'rect' | 'round' | 'stadium' | 'subroutine' | 'cylinder' | 'circle' | 'flag' | 'diamond' | 'hexagon' | 'parallelogram';
interface RawNode { id: string; label: string; shape: Shape; group: string | null }
interface RawEdge { from: string; to: string; label: string; style: 'solid' | 'dotted' | 'thick'; both: boolean }
interface RawGroup { id: string; label: string }

const STYLE_LINE = /^(?:style|classDef|class|linkStyle|click)\b/;
const NODE_RE = /^([A-Za-z0-9_][\w-]*)\s*(?:(\[\[|\[\(|\(\(|\(\[|\{\{|\[\/|\[\\|\[|\(|\{|>)\s*("[^"]*"|[^\]\)\}]*?)\s*(\]\]|\)\]|\)\)|\]\)|\}\}|\/\]|\\\]|\]|\)|\}))?$/;
const LINK_RE = /\s*(<?(?:-{2,}|={2,}|-\.+-?)[>xo]?)\s*(?:\|([^|]*)\|)?\s*/g;

function slugId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'n';
}

function shapeOf(open: string | undefined): Shape {
  switch (open) {
    case '[[': return 'subroutine'; case '[(': return 'cylinder'; case '((': return 'circle'; case '([': return 'stadium';
    case '{{': return 'hexagon'; case '[/': case '[\\': return 'parallelogram'; case '(': return 'round'; case '{': return 'diamond'; case '>': return 'flag';
    default: return 'rect';
  }
}

function unquote(s: string): string {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t).replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** Normalise `-- text -->`, `-. text .->`, `== text ==>` into the `-->|text|` form so one link regex serves. */
function normaliseLinkText(line: string): string {
  return line
    .replace(/--\s*([^-|>][^-|>]*?)\s*-->/g, '-->|$1|')
    .replace(/-\.\s*([^.|>][^.|>]*?)\s*\.->/g, '-.->|$1|')
    .replace(/==\s*([^=|>][^=|>]*?)\s*==>/g, '==>|$1|');
}

interface Parsed { direction: string; nodes: Map<string, RawNode>; edges: RawEdge[]; groups: RawGroup[]; dropped: string[]; notes: string[] }

export function parseMermaidFlowchart(text: string): Parsed {
  if (text.length > MERMAID_LIMITS.chars) throw new Error(`Mermaid source is over ${MERMAID_LIMITS.chars} chars`);
  const directives: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => {
    const t = l.trim();
    if (/^%%\{/.test(t)) { directives.push(t.slice(0, 80)); return ''; } // an init directive is styling — dropped, reported
    return t.replace(/%%.*$/, '').trim();
  }).filter(Boolean);
  const header = lines.findIndex((l) => /^(flowchart|graph)\b/i.test(l));
  if (header < 0) {
    const other = lines.find((l) => /^(sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline)\b/i.test(l));
    throw new Error(other ? `only flowchart / graph is imported; this is a ${other.split(/\s/)[0]}` : 'no `flowchart` or `graph` header found');
  }
  const direction = (/^(?:flowchart|graph)\s+([A-Za-z]{2})?/i.exec(lines[header])?.[1] ?? 'TD').toUpperCase();
  const nodes = new Map<string, RawNode>(); const edges: RawEdge[] = []; const groups: RawGroup[] = []; const dropped: string[] = [...directives]; const notes: string[] = [];
  const groupStack: string[] = [];
  const ensure = (token: string): string | null => {
    const m = NODE_RE.exec(token.trim());
    if (!m) return null;
    const id = m[1]; const label = m[3] !== undefined ? unquote(m[3]) : '';
    const existing = nodes.get(id);
    if (existing) { if (label && !existing.label) existing.label = label; if (m[2] && existing.shape === 'rect') existing.shape = shapeOf(m[2]); return id; }
    if (nodes.size >= MERMAID_LIMITS.nodes) { dropped.push(`node ${id} (over the ${MERMAID_LIMITS.nodes}-node bound)`); return null; }
    nodes.set(id, { id, label: label || id, shape: shapeOf(m[2]), group: groupStack[0] ?? null });
    return id;
  };
  for (const raw of lines.slice(header + 1)) {
    for (const stmt of raw.split(';').map((s) => s.trim()).filter(Boolean)) {
      if (/^%%\{/.test(stmt) || STYLE_LINE.test(stmt)) { dropped.push(stmt.slice(0, 80)); continue; }
      const sg = /^subgraph\s+(.+)$/i.exec(stmt);
      if (sg) {
        const m = /^("[^"]*"|[^\[\s]+)\s*(?:\[\s*("[^"]*"|[^\]]*)\s*\])?$/.exec(sg[1].trim());
        const id = m ? unquote(m[1]) : sg[1].trim(); const label = m && m[2] ? unquote(m[2]) : unquote(id);
        if (groupStack.length) notes.push(`nested subgraph "${label}" flattened into "${groups.find((g) => g.id === groupStack[0])?.label ?? groupStack[0]}"`);
        else groups.push({ id, label });
        groupStack.push(groupStack[0] ?? id);
        continue;
      }
      if (/^end$/i.test(stmt)) { groupStack.pop(); continue; }
      if (/^direction\s+/i.test(stmt)) continue;
      const line = normaliseLinkText(stmt);
      const parts: string[] = []; const links: Array<{ op: string; label: string }> = [];
      let last = 0; LINK_RE.lastIndex = 0; let m: RegExpExecArray | null;
      while ((m = LINK_RE.exec(line))) { parts.push(line.slice(last, m.index)); links.push({ op: m[1], label: unquote(m[2] ?? '') }); last = m.index + m[0].length; }
      parts.push(line.slice(last));
      if (!links.length) { if (ensure(line) === null) dropped.push(stmt.slice(0, 80)); continue; }
      const groupsOfNodes = parts.map((p) => p.split('&').map((t) => t.trim()).filter(Boolean).map(ensure).filter((id): id is string => !!id));
      for (let i = 0; i < links.length; i++) {
        const { op, label } = links[i];
        const style: RawEdge['style'] = op.includes('=') ? 'thick' : op.includes('.') ? 'dotted' : 'solid';
        const both = op.startsWith('<') && op.endsWith('>');
        for (const from of groupsOfNodes[i]) for (const to of groupsOfNodes[i + 1] ?? []) {
          if (edges.length >= MERMAID_LIMITS.edges) { dropped.push(`link ${from} → ${to} (over the ${MERMAID_LIMITS.edges}-link bound)`); continue; }
          edges.push({ from, to, label, style, both });
        }
      }
    }
  }
  if (direction !== 'TD' && direction !== 'TB') notes.push(`direction ${direction} ignored — the renderer lays the document out`);
  return { direction, nodes, edges, groups, dropped, notes };
}

function workflowShape(n: RawNode, isFirst: boolean, hasIncoming: boolean, hasOutgoing: boolean): WorkflowNode['shape'] {
  const name = n.label.toLowerCase();
  if (n.shape === 'diamond' || n.shape === 'hexagon') return 'decision';
  if (n.shape === 'subroutine' || n.shape === 'cylinder') return 'tool';
  if (n.shape === 'stadium' || n.shape === 'circle') {
    if (/\b(end|stop|done|finish|exit)\b/.test(name) || (!hasOutgoing && hasIncoming)) return 'end';
    if (/\b(start|begin|open)\b/.test(name) || isFirst || !hasIncoming) return 'start';
  }
  return 'step';
}

function componentType(n: RawNode): DiagramComponentType {
  if (n.shape === 'cylinder') return 'database';
  return inferComponentType(n.label);
}

/** Author a fresh workflow or architecture document from Mermaid flowchart text. */
export function importMermaidDiagram(text: string, opts: MermaidImportOptions = {}): MermaidImport {
  const p = parseMermaidFlowchart(text);
  const nodes = [...p.nodes.values()];
  const ids = new Map<string, string>(); const used = new Set<string>();
  for (const n of nodes) { let id = slugId(n.id); let k = 2; while (used.has(id)) id = `${slugId(n.id)}-${k++}`; used.add(id); ids.set(n.id, id); }
  const groupIds = new Map<string, string>();
  for (const g of p.groups) { let id = slugId(g.id); let k = 2; while (used.has(id) || [...groupIds.values()].includes(id)) id = `${slugId(g.id)}-${k++}`; groupIds.set(g.id, id); }
  const decisionish = nodes.some((n) => n.shape === 'diamond' || n.shape === 'hexagon' || n.shape === 'stadium' || n.shape === 'circle');
  const kind = opts.kind ?? (decisionish ? 'workflow' : 'architecture');
  const notes = [...p.notes, opts.kind ? `kind ${kind} as requested` : `kind ${kind} inferred (${decisionish ? 'decision / start-end shapes present' : 'no flow shapes — read as components'})`];
  if (p.dropped.length) notes.push(`${p.dropped.length} line(s) not transcribed: styling, classes, clicks, or syntax outside flowchart nodes and links`);
  const title = opts.title?.trim() || (kind === 'workflow' ? 'Imported workflow' : 'Imported architecture');
  const incoming = new Set(p.edges.map((e) => e.to)); const outgoing = new Set(p.edges.map((e) => e.from));
  const unlabeled = p.edges.filter((e) => !e.label).length;
  if (unlabeled) notes.push(`${unlabeled} unlabeled link(s) given a default label (${kind === 'workflow' ? '"then"' : 'uses / async / data by link style'}) — the document requires one; edit them`);
  const edgeLabel = (e: RawEdge): string => e.label || (kind === 'workflow' ? 'then' : e.style === 'dotted' ? 'async' : e.style === 'thick' ? 'data' : 'uses');
  let diagram: WorkflowDiagram | ArchitectureDiagram;
  if (kind === 'workflow') {
    const lanes: WorkflowLane[] = p.groups.map((g) => ({ id: groupIds.get(g.id)!, label: g.label }));
    const wnodes: WorkflowNode[] = nodes.map((n, i) => ({ id: ids.get(n.id)!, label: n.label, evidence: 'authored', ...(n.group && groupIds.get(n.group) ? { lane: groupIds.get(n.group)! } : {}), shape: workflowShape(n, i === 0, incoming.has(n.id), outgoing.has(n.id)) }));
    const edges: DiagramRelation[] = p.edges.map((e, i) => ({ id: `e${i + 1}`, label: edgeLabel(e), from: ids.get(e.from)!, to: ids.get(e.to)!, evidence: 'authored' }));
    diagram = { schemaVersion: DIAGRAM_SCHEMA_VERSION, kind: 'workflow', meta: { title }, ...(lanes.length ? { lanes } : {}), nodes: wnodes, edges };
  } else {
    const components: ArchitectureComponent[] = nodes.map((n) => ({ id: ids.get(n.id)!, label: n.label, type: componentType(n), evidence: 'authored' }));
    const boundaries: ArchitectureBoundary[] = p.groups.map((g) => ({ id: groupIds.get(g.id)!, label: g.label, kind: 'group' as const, wraps: nodes.filter((n) => n.group === g.id).map((n) => ids.get(n.id)!) })).filter((b) => b.wraps.length);
    const connections: ArchitectureConnection[] = p.edges.map((e, i) => ({ id: `c${i + 1}`, label: edgeLabel(e), from: ids.get(e.from)!, to: ids.get(e.to)!, evidence: 'authored', style: e.style === 'dotted' ? 'async' : e.style === 'thick' ? 'data' : 'sync', ...(e.both ? { direction: 'both' } : {}) }));
    diagram = { schemaVersion: DIAGRAM_SCHEMA_VERSION, kind: 'architecture', meta: { title }, components, ...(boundaries.length ? { boundaries } : {}), connections };
  }
  const validation = validateDiagram(diagram, { quality: 'standard' });
  return { diagram, notes, dropped: p.dropped, validation };
}

/**
 * Atlas-seeded architecture drafts (ADR-056 D-A3).
 *
 * The Atlas graph is a measurement of the whole tree; a diagram is a curated
 * story of at most twelve elements. This draft is the honest bridge: each
 * enriched Atlas layer becomes one component (type inferred from the layer's
 * vocabulary, never from file proximity), the enrichment's layer→layer
 * relationships become labelled connections (falling back to counted `imports`
 * edges when no enrichment ran), and the layer's facade files — service ports
 * first — become `sources` the verifier can check. Everything is `authored`
 * until the repository confirms it. The cap is enforced by size with the
 * omissions named, so the agent that curates the draft knows what it left out.
 */
import type { AtlasGraph, AtlasNode, ArchitectureComponent, ArchitectureConnection, ArchitectureDiagram, DiagramComponentType } from '@kinqs/brainrouter-types';
import { detectServicePorts } from '../atlas/service/servicePorts.js';
import { DIAGRAM_SHOWCASE_MAX_PRIMARY } from './schema.js';

export interface DraftOptions {
  /** Restrict to these layer ids or names (case-insensitive). */
  layers?: string[];
  /** Restrict to layers that own at least one file under this workspace-relative prefix. */
  pathPrefix?: string;
  /** Primary-element cap; default the showcase cap. */
  maxComponents?: number;
  /** Diagram title; default `<project> — architecture`. */
  title?: string;
}

export interface DiagramDraft {
  diagram: ArchitectureDiagram;
  /** Layers left out by the cap or the scope, largest first. */
  omittedLayers: string[];
  /** What the draft did and did not have — for the agent that curates it. */
  notes: string[];
}

const TYPE_RULES: Array<[RegExp, DiagramComponentType]> = [
  [/\b(ui|renderer|react|frontend|front-end|web|dashboard|pages?|components?|views?|desktop|browser|panel|tui|cli)\b/i, 'frontend'],
  [/\b(db|database|store|storage|postgres|sqlite|schema|migrations?|persist|repository|cache|index)\b/i, 'database'],
  [/\b(queue|bus|events?|messaging|pubsub|stream|kafka|topic|webhook|inbox|delivery)\b/i, 'messagebus'],
  [/\b(auth|security|policy|permission|credential|token|sandbox|guard|redact|secret)\b/i, 'security'],
  [/\b(cloud|deploy|infra|infrastructure|docker|kubernetes|k8s|worker|edge|tunnel|relay|serverless)\b/i, 'cloud'],
  [/\b(external|third[- ]party|vendor|provider|upstream|integration|connector|github|openai|anthropic)\b/i, 'external'],
];

/** Infer a component type from a layer's name, description, and its nodes' tags. */
export function inferComponentType(text: string): DiagramComponentType {
  for (const [re, type] of TYPE_RULES) if (re.test(text)) return type;
  return 'backend';
}

const slug = (s: string): string => s.toLowerCase().replace(/^layer:/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'layer';
const FACADE = /(?:^|\/)(?:index|service|gateway|main|app|server|router|routes)\.[cm]?[jt]sx?$/;

export function draftDiagramFromAtlas(graph: AtlasGraph, opts: DraftOptions = {}): DiagramDraft {
  const notes: string[] = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const ports = detectServicePorts(graph);
  const portPaths = new Set(ports.ports.map((p) => p.path));
  const max = Math.max(2, opts.maxComponents ?? DIAGRAM_SHOWCASE_MAX_PRIMARY);

  const wanted = opts.layers?.map((l) => l.toLowerCase());
  const prefix = opts.pathPrefix?.replace(/^\.?\//, '').replace(/\/$/, '');
  let layers = graph.layers.filter((l) => l.nodeIds.length > 0);
  if (wanted?.length) layers = layers.filter((l) => wanted.includes(l.id.toLowerCase()) || wanted.includes(l.name.toLowerCase()) || wanted.includes(slug(l.id)));
  if (prefix) layers = layers.filter((l) => l.nodeIds.some((id) => (nodeById.get(id)?.filePath ?? '').startsWith(`${prefix}/`) || nodeById.get(id)?.filePath === prefix));
  const outOfScope = graph.layers.filter((l) => !layers.includes(l)).map((l) => l.name);
  layers = [...layers].sort((a, b) => b.nodeIds.length - a.nodeIds.length || a.id.localeCompare(b.id));
  const kept = layers.slice(0, max);
  const capped = layers.slice(max).map((l) => l.name);

  const idOf = new Map<string, string>();
  const used = new Set<string>();
  for (const l of kept) {
    let id = slug(l.id); let n = 2;
    while (used.has(id)) id = `${slug(l.id)}-${n++}`;
    used.add(id); idOf.set(l.id, id);
  }

  const components: ArchitectureComponent[] = kept.map((l) => {
    const files = l.nodeIds.map((id) => nodeById.get(id)).filter((n): n is AtlasNode => !!n && n.type === 'file' && !!n.filePath);
    const tags = files.flatMap((n) => n.tags ?? []).join(' ');
    const type = inferComponentType(`${l.name} ${l.description ?? ''} ${tags}`);
    const facades = files.map((n) => n.filePath!).sort((a, b) => Number(portPaths.has(b)) - Number(portPaths.has(a)) || Number(FACADE.test(b)) - Number(FACADE.test(a)) || a.localeCompare(b));
    const c: ArchitectureComponent = { id: idOf.get(l.id)!, label: l.name.slice(0, 200), type, evidence: 'authored' };
    if (l.description) c.description = l.description.slice(0, 2_000);
    const sources = facades.slice(0, 3).map((p) => ({ path: p }));
    if (sources.length) c.sources = sources;
    return c;
  });

  const connections: ArchitectureConnection[] = [];
  const seen = new Set<string>();
  if (graph.layerEdges?.length) {
    for (const e of graph.layerEdges) {
      const from = idOf.get(e.source), to = idOf.get(e.target);
      if (!from || !to || from === to || seen.has(`${from}>${to}`)) continue;
      seen.add(`${from}>${to}`);
      connections.push({ id: `c-${from}-${to}`, label: e.label.slice(0, 200), from, to, evidence: 'authored' });
    }
    notes.push(`${connections.length} connections from the enrichment's layer relationships.`);
  } else {
    const layerOf = new Map<string, string>();
    for (const l of kept) for (const id of l.nodeIds) layerOf.set(id, idOf.get(l.id)!);
    const counts = new Map<string, number>();
    for (const e of graph.edges) {
      if (e.type !== 'imports' && e.type !== 'calls' && e.type !== 'depends_on') continue;
      const from = layerOf.get(e.source), to = layerOf.get(e.target);
      if (!from || !to || from === to) continue;
      counts.set(`${from}>${to}`, (counts.get(`${from}>${to}`) ?? 0) + 1);
    }
    for (const [key, n] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      const [from, to] = key.split('>');
      connections.push({ id: `c-${from}-${to}`, label: `imports (${n})`, from, to, style: 'data', evidence: 'authored' });
    }
    notes.push(connections.length ? `${connections.length} connections aggregated from ${[...counts.values()].reduce((a, b) => a + b, 0)} import/call edges (no enriched layer relationships — run /atlas enrich for named ones).` : 'No relationships between the kept layers were found in the graph.');
  }

  if (capped.length) notes.push(`Capped at ${max} components by size; omitted: ${capped.join(', ')}.`);
  if (outOfScope.length && (wanted?.length || prefix)) notes.push(`Out of scope: ${outOfScope.join(', ')}.`);
  notes.push('Every element is authored — run verification (diagram_render verifies by default) to confirm sources at a revision. Curate: pick one main path, drop low-value connections, name the relationships.');

  const diagram: ArchitectureDiagram = {
    schemaVersion: 1,
    kind: 'architecture',
    meta: {
      title: (opts.title ?? `${graph.project.name} — architecture`).slice(0, 200),
      qualityProfile: 'showcase',
      ...(graph.project.gitCommitHash && /^[0-9a-f]{40}$/.test(graph.project.gitCommitHash) ? { repository: { revision: graph.project.gitCommitHash } } : {}),
    },
    components,
    connections,
  };
  return { diagram, omittedLayers: [...capped, ...outOfScope], notes };
}

import type {
  AssuranceCodeRelationshipEdge,
  AssuranceCodeSymbol,
  AssuranceImpactRelationship,
} from '@kinqs/brainrouter-types/review';
import type { ParserBackedIndexHandle } from '../index/graphTypes.js';

export type SecurityBoundaryRole = 'source' | 'sink';

export type SecurityBoundaryClassifier = (symbol: AssuranceCodeSymbol) => SecurityBoundaryRole | null;

export interface SelectedImpactContext {
  symbol: AssuranceCodeSymbol;
  edge: AssuranceCodeRelationshipEdge;
  relationship: AssuranceImpactRelationship;
  distance: number;
}

export interface SelectedSecurityPath {
  source: AssuranceCodeSymbol;
  sink: AssuranceCodeSymbol;
  edges: AssuranceCodeRelationshipEdge[];
}

export interface ImpactGraphSelection {
  changedSymbols: AssuranceCodeSymbol[];
  context: SelectedImpactContext[];
  securityPaths: SelectedSecurityPath[];
  contextTruncated: boolean;
  securityPathsTruncated: boolean;
}

export interface SelectImpactGraphOptions {
  contextDepth?: number;
  securityPathDepth?: number;
  maxContextSymbols?: number;
  maxSecurityPaths?: number;
  classifySecurityBoundary?: SecurityBoundaryClassifier;
}

const SOURCE_NAME = /(?:^|\.)(?:read|load|get|parse|input|request|param|body|source)[A-Z_.-]?/i;
const SINK_NAME = /(?:^|\.)(?:write|save|send|execute|exec|render|sink|output)[A-Z_.-]?/i;

export const defaultSecurityBoundaryClassifier: SecurityBoundaryClassifier = (symbol) => {
  if (SOURCE_NAME.test(symbol.name)) return 'source';
  if (SINK_NAME.test(symbol.name)) return 'sink';
  return null;
};

function symbolMatchesChange(
  symbol: AssuranceCodeSymbol,
  changed: { path: string; line?: number; endLine?: number; symbol?: string },
): boolean {
  if (symbol.location.path !== changed.path) return false;
  if (changed.symbol) {
    return symbol.name === changed.symbol || symbol.name.endsWith(`.${changed.symbol}`);
  }
  if (!changed.line) return symbol.kind === 'module';
  const changedEnd = changed.endLine ?? changed.line;
  const symbolStart = symbol.location.line ?? 1;
  const symbolEnd = symbol.location.endLine ?? symbolStart;
  return symbolStart <= changedEnd && symbolEnd >= changed.line;
}

function impactRelationship(
  edge: AssuranceCodeRelationshipEdge,
  currentSymbolId: string,
  neighbor: AssuranceCodeSymbol,
): AssuranceImpactRelationship {
  if (edge.relationship === 'tests') return 'test';
  if (edge.relationship === 'configures') return 'configuration';
  if (edge.relationship === 'imports' || neighbor.language === 'external') return 'dependency';
  if (edge.relationship === 'calls') {
    return edge.fromSymbolId === currentSymbolId ? 'callee' : 'caller';
  }
  return 'reference';
}

function relationshipPriority(relationship: AssuranceImpactRelationship): number {
  const priorities: Record<AssuranceImpactRelationship, number> = {
    source_to_sink: 0,
    caller: 1,
    callee: 2,
    configuration: 3,
    test: 4,
    dependency: 5,
    reference: 6,
    changed: 7,
  };
  return priorities[relationship];
}

function edgesBySymbol(relationships: AssuranceCodeRelationshipEdge[]): Map<string, AssuranceCodeRelationshipEdge[]> {
  const bySymbol = new Map<string, AssuranceCodeRelationshipEdge[]>();
  for (const edge of relationships) {
    bySymbol.set(edge.fromSymbolId, [...(bySymbol.get(edge.fromSymbolId) ?? []), edge]);
    bySymbol.set(edge.toSymbolId, [...(bySymbol.get(edge.toSymbolId) ?? []), edge]);
  }
  return bySymbol;
}

function securityNeighborhood(
  seedIds: Set<string>,
  callEdges: AssuranceCodeRelationshipEdge[],
  maxDepth: number,
): Set<string> {
  const adjacency = edgesBySymbol(callEdges);
  const visited = new Set(seedIds);
  let frontier = [...seedIds];
  for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const symbolId of frontier) {
      for (const edge of adjacency.get(symbolId) ?? []) {
        const neighbor = edge.fromSymbolId === symbolId ? edge.toSymbolId : edge.fromSymbolId;
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return visited;
}

function shortestCallPath(
  sourceId: string,
  sinkId: string,
  callEdges: AssuranceCodeRelationshipEdge[],
  maxDepth: number,
): AssuranceCodeRelationshipEdge[] | null {
  const adjacency = edgesBySymbol(callEdges);
  const queue: Array<{ symbolId: string; path: AssuranceCodeRelationshipEdge[] }> = [{ symbolId: sourceId, path: [] }];
  const visited = new Set([sourceId]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.path.length >= maxDepth) continue;
    for (const edge of adjacency.get(current.symbolId) ?? []) {
      const neighbor = edge.fromSymbolId === current.symbolId ? edge.toSymbolId : edge.fromSymbolId;
      if (visited.has(neighbor)) continue;
      const path = [...current.path, edge];
      if (neighbor === sinkId) return path;
      visited.add(neighbor);
      queue.push({ symbolId: neighbor, path });
    }
  }
  return null;
}

export function selectImpactGraph(
  index: ParserBackedIndexHandle,
  changed: Array<{ path: string; line?: number; endLine?: number; symbol?: string }>,
  options: SelectImpactGraphOptions = {},
): ImpactGraphSelection {
  const contextDepth = options.contextDepth ?? 2;
  const securityPathDepth = options.securityPathDepth ?? 6;
  const maxContextSymbols = options.maxContextSymbols ?? 120;
  const maxSecurityPaths = options.maxSecurityPaths ?? 8;
  const classify = options.classifySecurityBoundary ?? defaultSecurityBoundaryClassifier;
  const symbolsById = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));
  const changedSymbols = index.symbols.filter((symbol) =>
    changed.some((location) => symbolMatchesChange(symbol, location)),
  );
  const seedIds = new Set(changedSymbols.map((symbol) => symbol.id));
  const adjacency = edgesBySymbol(index.relationships);
  const selected = new Map<string, SelectedImpactContext>();
  const queue = [...seedIds].map((symbolId) => ({ symbolId, distance: 0 }));
  const visitedDistance = new Map([...seedIds].map((symbolId) => [symbolId, 0]));

  while (queue.length && selected.size < maxContextSymbols) {
    const current = queue.shift()!;
    if (current.distance >= contextDepth) continue;
    for (const edge of adjacency.get(current.symbolId) ?? []) {
      const neighborId = edge.fromSymbolId === current.symbolId ? edge.toSymbolId : edge.fromSymbolId;
      const neighbor = symbolsById.get(neighborId);
      if (!neighbor || seedIds.has(neighborId)) continue;
      const distance = current.distance + 1;
      const relationship = impactRelationship(edge, current.symbolId, neighbor);
      const existing = selected.get(neighborId);
      if (
        !existing ||
        distance < existing.distance ||
        (distance === existing.distance &&
          relationshipPriority(relationship) < relationshipPriority(existing.relationship))
      ) {
        selected.set(neighborId, { symbol: neighbor, edge, relationship, distance });
      }
      if ((visitedDistance.get(neighborId) ?? Number.MAX_SAFE_INTEGER) > distance) {
        visitedDistance.set(neighborId, distance);
        queue.push({ symbolId: neighborId, distance });
      }
    }
  }

  const callEdges = index.relationships.filter((edge) => edge.relationship === 'calls');
  const neighborhood = securityNeighborhood(seedIds, callEdges, securityPathDepth);
  const sources = index.symbols.filter((symbol) => neighborhood.has(symbol.id) && classify(symbol) === 'source');
  const sinks = index.symbols.filter((symbol) => neighborhood.has(symbol.id) && classify(symbol) === 'sink');
  const securityPaths: SelectedSecurityPath[] = [];
  const pathKeys = new Set<string>();
  for (const source of sources) {
    for (const sink of sinks) {
      const path = shortestCallPath(source.id, sink.id, callEdges, securityPathDepth);
      if (!path || path.length < 2) continue;
      const key = path
        .map((edge) => edge.id)
        .sort()
        .join(':');
      if (pathKeys.has(key)) continue;
      pathKeys.add(key);
      securityPaths.push({ source, sink, edges: path });
      if (securityPaths.length >= maxSecurityPaths) break;
    }
    if (securityPaths.length >= maxSecurityPaths) break;
  }

  return {
    changedSymbols,
    context: [...selected.values()].sort(
      (left, right) =>
        relationshipPriority(left.relationship) - relationshipPriority(right.relationship) ||
        left.distance - right.distance ||
        left.symbol.location.path.localeCompare(right.symbol.location.path) ||
        left.symbol.name.localeCompare(right.symbol.name),
    ),
    securityPaths,
    contextTruncated: queue.length > 0,
    securityPathsTruncated: securityPaths.length >= maxSecurityPaths,
  };
}

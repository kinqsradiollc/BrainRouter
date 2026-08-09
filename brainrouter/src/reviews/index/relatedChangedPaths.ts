/**
 * ADR-033 D2 — which changed files belong in one review unit, answered by the
 * code graph we already build rather than by a new heuristic.
 *
 * The bundle planner in core takes `relatedPaths` edges and unions the files
 * they name. Its own fallback derives those edges from import statements
 * visible IN THE DIFF, which is honest but thin: a unified diff shows three
 * lines of context around each hunk, and a file's imports sit at the top, so a
 * change that does not touch the import block produces no edges at all.
 *
 * The parser-backed index has the real answer. It is built at the exact
 * reviewed revision, from whole files, and its relationships already record
 * `imports`, `calls`, `tests` and `configures` between symbols. Mapping those
 * edges back to paths gives the planner "the route and the handler it calls"
 * even when neither hunk mentions the other.
 *
 * Two invariants keep this on the safe side of D9. It is PURE, so the grouping
 * is reproducible from an index and a changed set; and it can only ever JOIN
 * files that are already in the changeset — an edge with an endpoint outside it
 * is dropped, so nothing the diff says can widen the review's scope.
 */

import type {
  AssuranceCodeRelationshipEdge,
  AssuranceCodeSymbol,
} from '@kinqs/brainrouter-types/review';

/** As much of a parser-backed index as this derivation is allowed to see. */
export interface RelatedPathGraph {
  symbols: readonly AssuranceCodeSymbol[];
  relationships: readonly AssuranceCodeRelationshipEdge[];
  pathRelationships?: ReadonlyArray<readonly [string, string]>;
}

/**
 * Cap on the edges one plan may carry. A pathological index (a barrel file
 * imported by everything) would otherwise hand the planner a complete graph,
 * which unions every changed file into one bundle and undoes the split.
 */
export const MAX_RELATED_PATH_EDGES = 2_000;

/**
 * The related-file edges among `changedPaths`, derived from the index's symbol
 * relationships. Returns unordered `[a, b]` pairs, deduplicated, with `a < b`
 * so the same relationship is never reported twice.
 */
export function relatedChangedPathsFromGraph(
  graph: RelatedPathGraph,
  changedPaths: Iterable<string>,
): Array<[string, string]> {
  const changed = new Set<string>();
  for (const path of changedPaths) {
    const trimmed = String(path ?? '').trim();
    if (trimmed) changed.add(trimmed);
  }
  if (changed.size < 2) return []; // nothing to join

  const edges: Array<[string, string]> = [];
  const seen = new Set<string>();
  const addPair = (left: string | undefined, right: string | undefined): void => {
    if (edges.length >= MAX_RELATED_PATH_EDGES || !left || !right || left === right) return;
    if (!changed.has(left) || !changed.has(right)) return;
    const pair: [string, string] = left < right ? [left, right] : [right, left];
    const key = `${pair[0]}\u0000${pair[1]}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(pair);
  };

  for (const [from, to] of graph.pathRelationships ?? []) {
    addPair(from, to);
    if (edges.length >= MAX_RELATED_PATH_EDGES) return edges;
  }

  const pathBySymbol = new Map<string, string>();
  for (const symbol of graph.symbols) {
    const path = symbol.location?.path;
    // Only changed files can ever be an endpoint, so the lookup table stays
    // proportional to the change rather than to the repository.
    if (path && changed.has(path)) pathBySymbol.set(symbol.id, path);
  }
  if (pathBySymbol.size === 0) return edges;
  for (const relationship of graph.relationships) {
    if (edges.length >= MAX_RELATED_PATH_EDGES) break;
    const from = pathBySymbol.get(relationship.fromSymbolId);
    const to = pathBySymbol.get(relationship.toSymbolId);
    addPair(from, to);
  }
  return edges;
}

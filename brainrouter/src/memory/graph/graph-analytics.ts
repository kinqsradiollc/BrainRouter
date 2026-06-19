/**
 * DASH-1 (0.4.4) — graph analytics lenses over the GraphRAG store. Pure graph
 * algorithms (no I/O) so they're deterministic + unit-testable; the engine
 * feeds them the user's nodes + edges and exposes the results via
 * `memory_graph_analytics`. Four lenses:
 *   - PageRank centrality — which entities are most "load-bearing".
 *   - Articulation points — broker / bridge entities whose removal fragments
 *     the graph (knowledge that connects otherwise-separate clusters).
 *   - Shortest connection path — "how is A related to B".
 *   - Namespace overview — entity counts by type.
 */

export interface GraphEdgeLite {
  from: string;
  to: string;
}

/**
 * Iterative PageRank over the DIRECTED relation graph, with dangling-node mass
 * redistributed uniformly. Returns a node-id → score map (scores sum to ~1).
 */
export function pageRank(
  nodeIds: string[],
  edges: GraphEdgeLite[],
  opts?: { damping?: number; iterations?: number },
): Map<string, number> {
  const d = opts?.damping ?? 0.85;
  const iters = Math.max(1, opts?.iterations ?? 40);
  const n = nodeIds.length;
  const out = new Map<string, number>();
  if (n === 0) return out;

  const idx = new Map(nodeIds.map((id, i) => [id, i]));
  const adj: number[][] = Array.from({ length: n }, () => []);
  const outDeg = new Array(n).fill(0);
  for (const e of edges) {
    const f = idx.get(e.from);
    const t = idx.get(e.to);
    if (f == null || t == null || f === t) continue;
    adj[f].push(t);
    outDeg[f]++;
  }

  let pr = new Array(n).fill(1 / n);
  for (let it = 0; it < iters; it++) {
    const next = new Array(n).fill((1 - d) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outDeg[i] === 0) dangling += pr[i];
    const danglingShare = (d * dangling) / n;
    for (let i = 0; i < n; i++) {
      if (outDeg[i] === 0) continue;
      const share = (d * pr[i]) / outDeg[i];
      for (const j of adj[i]) next[j] += share;
    }
    for (let i = 0; i < n; i++) next[i] += danglingShare;
    pr = next;
  }
  for (let i = 0; i < n; i++) out.set(nodeIds[i], pr[i]);
  return out;
}

function undirectedAdjacency(nodeIds: string[], edges: GraphEdgeLite[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const id of nodeIds) adj.set(id, new Set());
  for (const e of edges) {
    if (e.from === e.to) continue;
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from)!.add(e.to);
    adj.get(e.to)!.add(e.from);
  }
  return adj;
}

/**
 * Articulation points (cut vertices) of the UNDIRECTED graph — entities whose
 * removal increases the number of connected components, i.e. brokers/bridges
 * that hold clusters together. Iterative Tarjan (no recursion → safe on large
 * graphs). Returns the node ids, order-stable by input.
 */
export function articulationPoints(nodeIds: string[], edges: GraphEdgeLite[]): string[] {
  const adj = undirectedAdjacency(nodeIds, edges);
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const isCut = new Set<string>();
  let timer = 0;

  for (const root of nodeIds) {
    if (disc.has(root)) continue;
    // Iterative DFS; track parent + child count for the root special case.
    const stack: Array<{ node: string; parent: string | null; iter: Iterator<string> }> = [];
    disc.set(root, timer); low.set(root, timer); timer++;
    stack.push({ node: root, parent: null, iter: adj.get(root)!.values() });
    let rootChildren = 0;

    while (stack.length) {
      const top = stack[stack.length - 1];
      const step = top.iter.next();
      if (step.done) {
        stack.pop();
        const parent = top.parent;
        if (parent !== null) {
          low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!));
          if (parent !== root && low.get(top.node)! >= disc.get(parent)!) isCut.add(parent);
        }
        continue;
      }
      const next = step.value;
      if (!disc.has(next)) {
        if (top.node === root) rootChildren++;
        disc.set(next, timer); low.set(next, timer); timer++;
        stack.push({ node: next, parent: top.node, iter: adj.get(next)!.values() });
      } else if (next !== top.parent) {
        low.set(top.node, Math.min(low.get(top.node)!, disc.get(next)!));
      }
    }
    if (rootChildren >= 2) isCut.add(root);
  }
  return nodeIds.filter((id) => isCut.has(id));
}

/**
 * Shortest connection path between two nodes over the UNDIRECTED graph (BFS).
 * Returns the node-id path inclusive of both ends, or null when unreachable /
 * either endpoint is unknown.
 */
export function shortestPath(nodeIds: string[], edges: GraphEdgeLite[], from: string, to: string): string[] | null {
  const adj = undirectedAdjacency(nodeIds, edges);
  if (!adj.has(from) || !adj.has(to)) return null;
  if (from === to) return [from];
  const prev = new Map<string, string | null>([[from, null]]);
  const queue: string[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur)!) {
      if (prev.has(nb)) continue;
      prev.set(nb, cur);
      if (nb === to) {
        const path: string[] = [];
        let at: string | null = to;
        while (at !== null) { path.push(at); at = prev.get(at)!; }
        return path.reverse();
      }
      queue.push(nb);
    }
  }
  return null;
}

/** Entity counts grouped by type — a namespace overview. */
export function namespaceOverview(nodes: Array<{ entityType: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    const key = node.entityType || 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

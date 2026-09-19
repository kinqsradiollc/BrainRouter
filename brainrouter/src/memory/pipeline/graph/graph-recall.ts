import type { IMemoryStore } from "@kinqs/brainrouter-types";

/**
 * How much graph a recall may append.
 *
 * This block is glued onto EVERY `memory_recall` / `memory_search` response as
 * `appendSystemContext`, and it was unbounded: every matched node's 2-hop
 * neighbourhood, every node and every edge, formatted one per line. A real
 * session returned **124 KB of appendSystemContext around 4.9 KB of actual
 * records** — 1,835 lines of graph, 96% of a 154 KB tool result. It then
 * exceeded the tool-result clamp, so the model saw an 800-character preview of
 * the graph dump instead of the five records that answered its question.
 *
 * A relationship list longer than this is not context, it is noise with a
 * citation. The counts stay so the reader knows what was left out.
 */
export const GRAPH_CONTEXT_MAX_NODES = 60;
export const GRAPH_CONTEXT_MAX_EDGES = 80;

/**
 * Hybrid GraphRAG Recall Expansion
 * Finds matching entities in the query and top Cognitive results, performs a 2-hop
 * BFS traversal, and returns a formatted markdown block of the context.
 */
export async function expandRecallWithGraph(params: {
  topCognitiveResults: any[];
  query: string;
  userId: string;
  activeSkill?: string;
  store: IMemoryStore;
}): Promise<string> {
  const { topCognitiveResults, query, userId, activeSkill, store } = params;

  try {
    // 1. Fetch all graph nodes for this user to match entities
    const allNodes = await store.getAllGraphNodes(userId);
    if (allNodes.length === 0) return "";

    const combinedText = `${query} ${topCognitiveResults.map(r => r.content || "").join(" ")}`.toLowerCase();

    // 2. Find which nodes are mentioned in the query or top results
    const matchingNodeIds = new Set<string>();
    for (const node of allNodes) {
      if (combinedText.includes(node.entity.toLowerCase())) {
        matchingNodeIds.add(node.id);
      }
    }

    if (matchingNodeIds.size === 0) return "";

    // 3. For each matching node, fetch neighbors up to 2 hops
    const unionNodes = new Map<string, any>();
    const unionEdges = new Map<string, any>();

    for (const nodeId of matchingNodeIds) {
      const { nodes, edges } = await store.getGraphNeighbors(userId, nodeId, activeSkill, 2);
      for (const n of nodes) unionNodes.set(n.id, n);
      for (const e of edges) unionEdges.set(e.id, e);
    }

    if (unionNodes.size === 0) return "";

    // 4. Format into a bounded Knowledge Graph Context. The nodes that MATCHED
    // the query come first — they are why this block exists at all; their
    // neighbours are supporting cast and are the first thing dropped.
    const orderedNodes = Array.from(unionNodes.values()).sort((a, b) => {
      const aMatched = matchingNodeIds.has(a.id) ? 0 : 1;
      const bMatched = matchingNodeIds.has(b.id) ? 0 : 1;
      return aMatched - bMatched;
    });
    const shownNodes = orderedNodes.slice(0, GRAPH_CONTEXT_MAX_NODES);
    const shownNodeIds = new Set(shownNodes.map((n) => n.id));
    const nodeLines = shownNodes.map(
      n => `- **${n.entity}** (${n.entityType})`
    );
    // Only edges BETWEEN shown nodes: an edge naming an entity that was cut is
    // a dangling reference, which reads as a fact about something invisible.
    const relevantEdges = Array.from(unionEdges.values())
      .filter((e) => shownNodeIds.has(e.fromNodeId) && shownNodeIds.has(e.toNodeId))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const shownEdges = relevantEdges.slice(0, GRAPH_CONTEXT_MAX_EDGES);
    const edgeLines = shownEdges.map(e => {
      const fromNode = unionNodes.get(e.fromNodeId);
      const toNode = unionNodes.get(e.toNodeId);
      if (!fromNode || !toNode) return null;
      return `- **${fromNode.entity}** --[${e.relation}]--> **${toNode.entity}** (confidence: ${e.confidence.toFixed(2)}${e.skillTag ? `, skill: ${e.skillTag}` : ""})`;
    }).filter(Boolean);

    const omittedNodes = orderedNodes.length - shownNodes.length;
    const omittedEdges = relevantEdges.length - shownEdges.length;

    let output = "\n==================================================\n";
    output += "🕸️ KNOWLEDGE GRAPH CONTEXT (GraphRAG)\n";
    output += "==================================================\n\n";
    output += "### Graph Entities:\n" + nodeLines.join("\n") + "\n";
    if (omittedNodes > 0) {
      output += `- …and ${omittedNodes} further ${omittedNodes === 1 ? "entity" : "entities"} `
        + "(use memory_graph_query to walk from a specific one)\n";
    }
    output += "\n### Graph Relationships:\n" + edgeLines.join("\n") + "\n";
    if (omittedEdges > 0) {
      output += `- …and ${omittedEdges} further ${omittedEdges === 1 ? "relationship" : "relationships"}\n`;
    }

    return output;
  } catch (err) {
    console.error("[BrainRouter] Graph recall expansion failed:", (err as Error).message);
    return "";
  }
}

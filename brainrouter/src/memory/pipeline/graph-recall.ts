import type { IMemoryStore } from "@brainrouter/types";

/**
 * Hybrid GraphRAG Recall Expansion
 * Finds matching entities in the query and top Cognitive results, performs a 2-hop
 * BFS traversal, and returns a formatted markdown block of the context.
 */
export function expandRecallWithGraph(params: {
  topCognitiveResults: any[];
  query: string;
  userId: string;
  activeSkill?: string;
  store: IMemoryStore;
}): string {
  const { topCognitiveResults, query, userId, activeSkill, store } = params;

  try {
    // 1. Fetch all graph nodes for this user to match entities
    const allNodes = store.getAllGraphNodes(userId);
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
      const { nodes, edges } = store.getGraphNeighbors(userId, nodeId, activeSkill, 2);
      for (const n of nodes) unionNodes.set(n.id, n);
      for (const e of edges) unionEdges.set(e.id, e);
    }

    if (unionNodes.size === 0) return "";

    // 4. Format into a beautiful Knowledge Graph Context
    const nodeLines = Array.from(unionNodes.values()).map(
      n => `- **${n.entity}** (${n.entityType})`
    );
    const edgeLines = Array.from(unionEdges.values()).map(e => {
      const fromNode = unionNodes.get(e.fromNodeId);
      const toNode = unionNodes.get(e.toNodeId);
      if (!fromNode || !toNode) return null;
      return `- **${fromNode.entity}** --[${e.relation}]--> **${toNode.entity}** (confidence: ${e.confidence.toFixed(2)}${e.skillTag ? `, skill: ${e.skillTag}` : ""})`;
    }).filter(Boolean);

    let output = "\n==================================================\n";
    output += "🕸️ KNOWLEDGE GRAPH CONTEXT (GraphRAG)\n";
    output += "==================================================\n\n";
    output += "### Graph Entities:\n" + nodeLines.join("\n") + "\n\n";
    output += "### Graph Relationships:\n" + edgeLines.join("\n") + "\n";

    return output;
  } catch (err) {
    console.error("[BrainRouter] Graph recall expansion failed:", (err as Error).message);
    return "";
  }
}

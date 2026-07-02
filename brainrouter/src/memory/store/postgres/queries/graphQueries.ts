/**
 * Knowledge-graph (nodes + edges) SQL — verbatim extraction from
 * `PostgresMemoryStore`. The private `graphNodeRow`/`graphEdgeRow` mappers are
 * now exported free functions; the `getGraphNeighbors` BFS keeps its nested
 * `nodeById` closure unchanged.
 */

import type {
  GraphNode,
  GraphEdge,
} from "@kinqs/brainrouter-types";
import { asNumber, pg } from "../converters.js";
import type { Executor } from "./executor.js";

export function graphNodeRow(r: any): GraphNode {
  return {
    id: r.id, userId: r.user_id, entity: r.entity, entityType: r.entity_type,
    skillTag: r.skill_tag, confidence: asNumber(r.confidence, 1), sourceRecordId: r.source_record_id, createdTime: r.created_time,
  };
}

export function graphEdgeRow(r: any): GraphEdge {
  return {
    id: r.id, userId: r.user_id, fromNodeId: r.from_node_id, toNodeId: r.to_node_id,
    relation: r.relation, skillTag: r.skill_tag, confidence: asNumber(r.confidence, 1),
    sourceRecordId: r.source_record_id, createdTime: r.created_time,
  };
}

export async function getAllGraphNodes(exec: Executor, userId: string): Promise<GraphNode[]> {
  const rows = await exec.rows<any>(
    "SELECT id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time FROM graph_nodes WHERE user_id = $1",
    [userId],
  );
  return rows.map((r) => graphNodeRow(r));
}

export async function getAllGraphEdges(exec: Executor, userId: string): Promise<GraphEdge[]> {
  const rows = await exec.rows<any>(
    "SELECT id, user_id, from_node_id, to_node_id, relation, skill_tag, confidence, source_record_id, created_time FROM graph_edges WHERE user_id = $1",
    [userId],
  );
  return rows.map((r) => graphEdgeRow(r));
}

export async function upsertGraphNode(exec: Executor, node: GraphNode): Promise<void> {
  await exec.run(
    `INSERT INTO graph_nodes (id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       entity_type=EXCLUDED.entity_type, skill_tag=EXCLUDED.skill_tag,
       confidence=EXCLUDED.confidence, source_record_id=EXCLUDED.source_record_id`,
    [node.id, node.userId, node.entity, node.entityType, node.skillTag || "", node.confidence, node.sourceRecordId, node.createdTime],
  );
}

export async function upsertGraphEdge(exec: Executor, edge: GraphEdge): Promise<void> {
  await exec.run(
    `INSERT INTO graph_edges (id, user_id, from_node_id, to_node_id, relation, skill_tag, confidence, source_record_id, created_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id, from_node_id, to_node_id, relation) DO UPDATE SET
       skill_tag=EXCLUDED.skill_tag, confidence=EXCLUDED.confidence,
       source_record_id=EXCLUDED.source_record_id, created_time=EXCLUDED.created_time`,
    [edge.id, edge.userId, edge.fromNodeId, edge.toNodeId, edge.relation, edge.skillTag || "", edge.confidence, edge.sourceRecordId, edge.createdTime],
  );
}

export async function getGraphNodeByEntity(exec: Executor, userId: string, entity: string): Promise<GraphNode | null> {
  const row = await exec.one<any>(
    "SELECT id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time FROM graph_nodes WHERE user_id = $1 AND LOWER(entity) = LOWER($2)",
    [userId, entity],
  );
  return row ? graphNodeRow(row) : null;
}

export async function getGraphNeighbors(exec: Executor, userId: string, entityId: string, skillTag?: string, maxHops = 2): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const visitedNodes = new Map<string, GraphNode>();
  const visitedEdges = new Map<string, GraphEdge>();
  const nodeById = async (id: string): Promise<GraphNode | null> => {
    const row = await exec.one<any>(
      "SELECT id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time FROM graph_nodes WHERE user_id = $1 AND id = $2",
      [userId, id],
    );
    return row ? graphNodeRow(row) : null;
  };
  const start = await nodeById(entityId);
  if (!start) return { nodes: [], edges: [] };
  visitedNodes.set(start.id, start);

  let queue = [start.id];
  let currentHop = 0;
  while (queue.length > 0 && currentHop < maxHops) {
    const nextQueue: string[] = [];
    for (const nodeId of queue) {
      const params: any[] = [userId, nodeId, nodeId];
      let edgeSql =
        "SELECT id, user_id, from_node_id, to_node_id, relation, skill_tag, confidence, source_record_id, created_time FROM graph_edges WHERE user_id = ? AND (from_node_id = ? OR to_node_id = ?)";
      if (skillTag) {
        edgeSql += " AND (skill_tag = ? OR skill_tag = '')";
        params.push(skillTag);
      }
      const edgeRows = await exec.rows<any>(pg(edgeSql), params);
      for (const row of edgeRows) {
        const edge = graphEdgeRow(row);
        visitedEdges.set(edge.id, edge);
        const neighborId = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
        if (!visitedNodes.has(neighborId)) {
          const neighbor = await nodeById(neighborId);
          if (neighbor) {
            visitedNodes.set(neighborId, neighbor);
            nextQueue.push(neighborId);
          }
        }
      }
    }
    queue = nextQueue;
    currentHop++;
  }
  return { nodes: Array.from(visitedNodes.values()), edges: Array.from(visitedEdges.values()) };
}

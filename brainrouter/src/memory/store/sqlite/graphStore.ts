/**
 * ADR-004 Phase 3 — GraphRAG nodes & edges capability.
 *
 * Extracted VERBATIM from `SqliteMemoryStore` (1/10 coupling: touches only
 * `graph_nodes` / `graph_edges` via `this.db`, no cross-capability calls).
 * `SqliteMemoryStore` composes one of these and delegates.
 */

import { DatabaseSync } from "node:sqlite";
import type { GraphNode, GraphEdge } from "@kinqs/brainrouter-types";

export class SqliteGraphStore {
  constructor(private readonly db: DatabaseSync) {}

  public getAllGraphNodes(userId: string): GraphNode[] {
    const stmt = this.db.prepare("SELECT id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time FROM graph_nodes WHERE user_id = ?");
    const rows = stmt.all(userId) as any[];
    return rows.map(r => ({
      id: r.id, userId: r.user_id, entity: r.entity,
      entityType: r.entity_type, skillTag: r.skill_tag,
      confidence: r.confidence, sourceRecordId: r.source_record_id,
      createdTime: r.created_time
    }));
  }

  /** DASH-1 — all of a user's graph edges (for whole-graph analytics). */
  public getAllGraphEdges(userId: string): GraphEdge[] {
    const rows = this.db.prepare(
      "SELECT id, user_id, from_node_id, to_node_id, relation, skill_tag, confidence, source_record_id, created_time FROM graph_edges WHERE user_id = ?",
    ).all(userId) as any[];
    return rows.map(r => ({
      id: r.id, userId: r.user_id, fromNodeId: r.from_node_id, toNodeId: r.to_node_id,
      relation: r.relation, skillTag: r.skill_tag, confidence: r.confidence,
      sourceRecordId: r.source_record_id, createdTime: r.created_time,
    }));
  }

  public upsertGraphNode(node: GraphNode) {
    const stmt = this.db.prepare(`
      INSERT INTO graph_nodes (id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        entity_type=excluded.entity_type,
        skill_tag=excluded.skill_tag,
        confidence=excluded.confidence,
        source_record_id=excluded.source_record_id
    `);
    stmt.run(
      node.id, node.userId, node.entity, node.entityType, node.skillTag || "",
      node.confidence, node.sourceRecordId, node.createdTime
    );
  }

  public upsertGraphEdge(edge: GraphEdge) {
    const stmt = this.db.prepare(`
      INSERT INTO graph_edges (id, user_id, from_node_id, to_node_id, relation, skill_tag, confidence, source_record_id, created_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, from_node_id, to_node_id, relation) DO UPDATE SET
        skill_tag=excluded.skill_tag,
        confidence=excluded.confidence,
        source_record_id=excluded.source_record_id,
        created_time=excluded.created_time
    `);
    stmt.run(
      edge.id, edge.userId, edge.fromNodeId, edge.toNodeId, edge.relation,
      edge.skillTag || "", edge.confidence, edge.sourceRecordId, edge.createdTime
    );
  }

  public getGraphNodeByEntity(userId: string, entity: string): GraphNode | null {
    const stmt = this.db.prepare(
      "SELECT id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time FROM graph_nodes WHERE user_id = ? AND LOWER(entity) = LOWER(?)"
    );
    const row = stmt.get(userId, entity) as any;
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      entity: row.entity,
      entityType: row.entity_type,
      skillTag: row.skill_tag,
      confidence: row.confidence,
      sourceRecordId: row.source_record_id,
      createdTime: row.created_time
    };
  }

  public getGraphNeighbors(userId: string, entityId: string, skillTag?: string, maxHops = 2): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const visitedNodes = new Map<string, GraphNode>();
    const visitedEdges = new Map<string, GraphEdge>();

    const stmtNodeById = this.db.prepare(
      "SELECT id, user_id, entity, entity_type, skill_tag, confidence, source_record_id, created_time FROM graph_nodes WHERE user_id = ? AND id = ?"
    );
    const startRow = stmtNodeById.get(userId, entityId) as any;
    if (!startRow) return { nodes: [], edges: [] };

    const startNode: GraphNode = {
      id: startRow.id,
      userId: startRow.user_id,
      entity: startRow.entity,
      entityType: startRow.entity_type,
      skillTag: startRow.skill_tag,
      confidence: startRow.confidence,
      sourceRecordId: startRow.source_record_id,
      createdTime: startRow.created_time
    };
    visitedNodes.set(startNode.id, startNode);

    let queue = [startNode.id];
    let currentHop = 0;

    while (queue.length > 0 && currentHop < maxHops) {
      const nextQueue: string[] = [];

      for (const nodeId of queue) {
        const queryParams: any[] = [userId, nodeId, nodeId];

        let edgeSql = `
          SELECT id, user_id, from_node_id, to_node_id, relation, skill_tag, confidence, source_record_id, created_time
          FROM graph_edges
          WHERE user_id = ? AND (from_node_id = ? OR to_node_id = ?)
        `;
        if (skillTag) {
          edgeSql += " AND (skill_tag = ? OR skill_tag = '')";
          queryParams.push(skillTag);
        }

        const stmtEdges = this.db.prepare(edgeSql);
        const edgeRows = stmtEdges.all(...queryParams) as any[];

        for (const row of edgeRows) {
          const edge: GraphEdge = {
            id: row.id,
            userId: row.user_id,
            fromNodeId: row.from_node_id,
            toNodeId: row.to_node_id,
            relation: row.relation,
            skillTag: row.skill_tag,
            confidence: row.confidence,
            sourceRecordId: row.source_record_id,
            createdTime: row.created_time
          };
          visitedEdges.set(edge.id, edge);

          const neighborId = edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId;
          if (!visitedNodes.has(neighborId)) {
            const neighborRow = stmtNodeById.get(userId, neighborId) as any;
            if (neighborRow) {
              const neighborNode: GraphNode = {
                id: neighborRow.id,
                userId: neighborRow.user_id,
                entity: neighborRow.entity,
                entityType: neighborRow.entity_type,
                skillTag: neighborRow.skill_tag,
                confidence: neighborRow.confidence,
                sourceRecordId: neighborRow.source_record_id,
                createdTime: neighborRow.created_time
              };
              visitedNodes.set(neighborId, neighborNode);
              nextQueue.push(neighborId);
            }
          }
        }
      }

      queue = nextQueue;
      currentHop++;
    }

    return {
      nodes: Array.from(visitedNodes.values()),
      edges: Array.from(visitedEdges.values())
    };
  }
}

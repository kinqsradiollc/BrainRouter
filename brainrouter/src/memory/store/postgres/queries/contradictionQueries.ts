/**
 * Contradiction SQL — verbatim extraction from `PostgresMemoryStore`.
 */

import { randomUUID } from "node:crypto";
import type {
  ContradictionRecord,
  CursorPaginationOptions,
} from "@kinqs/brainrouter-types";
import { pg } from "../converters.js";
import type { Executor } from "./executor.js";
import { insertOperation } from "./operationsQueries.js";

export async function upsertContradiction(exec: Executor, data: {
  id: string; userId: string; recordIdA: string; recordIdB: string; reason: string; confidence: number; createdTime?: string;
}): Promise<void> {
  await exec.run(
    `INSERT INTO contradictions (id, user_id, record_id_a, record_id_b, reason, confidence, created_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET reason=EXCLUDED.reason, confidence=EXCLUDED.confidence`,
    [data.id, data.userId, data.recordIdA, data.recordIdB, data.reason, data.confidence, data.createdTime ?? new Date().toISOString()],
  );
}

export async function getPendingContradictions(exec: Executor, userId: string, pagination?: CursorPaginationOptions<{ confidence: number; id: string }>, statusFilter: "pending" | "resolved" | "dismissed" | "all" = "pending"): Promise<ContradictionRecord[]> {
  const where = ["c.user_id = ?"];
  const args: any[] = [userId];
  if (statusFilter !== "all") {
    where.push("c.status = ?");
    args.push(statusFilter);
  }
  if (pagination?.cursor) {
    where.push("(c.confidence < ? OR (c.confidence = ? AND c.id > ?))");
    args.push(pagination.cursor.confidence, pagination.cursor.confidence, pagination.cursor.id);
  }
  args.push(pagination?.limit ?? 20);
  const rows = await exec.rows<any>(
    pg(`SELECT c.*, r1.content AS content_a, r2.content AS content_b
          FROM contradictions c
          JOIN cognitive_records r1 ON c.record_id_a = r1.record_id
          JOIN cognitive_records r2 ON c.record_id_b = r2.record_id
         WHERE ${where.join(" AND ")}
         ORDER BY c.confidence DESC, c.id ASC LIMIT ?`),
    args,
  );
  return rows as unknown as ContradictionRecord[];
}

export async function resolveContradiction(exec: Executor, id: string, userId: string, status: "resolved" | "dismissed"): Promise<void> {
  await exec.run("UPDATE contradictions SET status = $1 WHERE id = $2 AND user_id = $3", [status, id, userId]);
  await insertOperation(exec, {
    id: randomUUID(), userId, recordId: id, operation: "contradiction_resolve", actor: "system",
    sessionKey: "", reason: status, createdAt: new Date().toISOString(), metadata: { contradictionId: id, status },
  });
}

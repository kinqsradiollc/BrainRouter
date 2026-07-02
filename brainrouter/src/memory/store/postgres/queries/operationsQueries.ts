/**
 * Evidence + operation-log SQL, plus the memory export/import round-trip and
 * hard-delete (verbatim extraction from `PostgresMemoryStore`).
 */

import { randomUUID } from "node:crypto";
import type {
  CursorPaginationOptions,
  EvidenceListFilters,
  ImportResult,
  MemoryEvidence,
  MemoryExport,
  MemoryImport,
  MemoryOperation,
  OperationLogFilters,
} from "@kinqs/brainrouter-types";
import {
  cognitiveRowToRecord,
  evidenceRowToRecord,
  operationRowToRecord,
  pg,
} from "../converters.js";
import { expandImportRecord, readImportChunkChars } from "../../../pipeline/chunk-import.js";
import type { Executor } from "./executor.js";
import { upsertCognitiveMeta, replaceFileIndexTx } from "./cognitiveQueries.js";

export async function insertEvidence(exec: Executor, ev: MemoryEvidence): Promise<void> {
  await exec.run(
    `INSERT INTO memory_evidence (id, user_id, record_id, kind, ref, excerpt, observed_at, metadata_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       kind=EXCLUDED.kind, ref=EXCLUDED.ref, excerpt=EXCLUDED.excerpt,
       observed_at=EXCLUDED.observed_at, metadata_json=EXCLUDED.metadata_json`,
    [ev.id, ev.userId, ev.recordId, ev.kind, ev.ref, ev.excerpt, ev.observedAt, JSON.stringify(ev.metadata ?? {})],
  );
  await insertOperation(exec, {
    id: randomUUID(), userId: ev.userId, recordId: ev.recordId, operation: "evidence_add", actor: "system",
    sessionKey: "", reason: "", createdAt: new Date().toISOString(), metadata: { evidenceId: ev.id, kind: ev.kind, ref: ev.ref },
  });
}

export async function getEvidenceByRecord(exec: Executor, userId: string, recordId: string): Promise<MemoryEvidence[]> {
  const rows = await exec.rows(
    `SELECT id, user_id, record_id, kind, ref, excerpt, observed_at, metadata_json
       FROM memory_evidence WHERE user_id = $1 AND record_id = $2
      ORDER BY observed_at DESC, id ASC`,
    [userId, recordId],
  );
  return rows.map(evidenceRowToRecord);
}

export async function listEvidence(
  exec: Executor,
  userId: string,
  filters?: EvidenceListFilters,
  pagination?: CursorPaginationOptions<{ observedAt: string; id: string }>,
): Promise<MemoryEvidence[]> {
  const where = ["user_id = ?"];
  const args: any[] = [userId];
  if (filters?.recordId) { where.push("record_id = ?"); args.push(filters.recordId); }
  if (filters?.kind) { where.push("kind = ?"); args.push(filters.kind); }
  if (pagination?.cursor) {
    where.push("(observed_at < ? OR (observed_at = ? AND id > ?))");
    args.push(pagination.cursor.observedAt, pagination.cursor.observedAt, pagination.cursor.id);
  }
  args.push(pagination?.limit ?? 100);
  const rows = await exec.rows(
    pg(`SELECT id, user_id, record_id, kind, ref, excerpt, observed_at, metadata_json
          FROM memory_evidence WHERE ${where.join(" AND ")}
         ORDER BY observed_at DESC, id ASC LIMIT ?`),
    args,
  );
  return rows.map(evidenceRowToRecord);
}

export async function insertOperation(exec: Executor, op: MemoryOperation): Promise<void> {
  await exec.run(
    `INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       operation=EXCLUDED.operation, actor=EXCLUDED.actor, session_key=EXCLUDED.session_key,
       reason=EXCLUDED.reason, metadata_json=EXCLUDED.metadata_json`,
    [op.id, op.userId, op.recordId, op.operation, op.actor, op.sessionKey, op.reason, op.createdAt, JSON.stringify(op.metadata ?? {})],
  );
}

export async function getOperationLog(
  exec: Executor,
  userId: string,
  options?: CursorPaginationOptions<{ createdAt: string; id: string }>,
  filters?: OperationLogFilters,
): Promise<MemoryOperation[]> {
  const where = ["user_id = ?"];
  const args: any[] = [userId];
  if (filters?.operation) { where.push("operation = ?"); args.push(filters.operation); }
  if (filters?.sessionKey) { where.push("session_key = ?"); args.push(filters.sessionKey); }
  if (filters?.createdAfter) { where.push("created_at >= ?"); args.push(filters.createdAfter); }
  if (filters?.createdBefore) { where.push("created_at <= ?"); args.push(filters.createdBefore); }
  if (options?.cursor) {
    where.push("(created_at < ? OR (created_at = ? AND id > ?))");
    args.push(options.cursor.createdAt, options.cursor.createdAt, options.cursor.id);
  }
  args.push(options?.limit ?? 100);
  const rows = await exec.rows(
    pg(`SELECT id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json
          FROM memory_operations WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC, id ASC LIMIT ?`),
    args,
  );
  return rows.map(operationRowToRecord);
}

export async function exportMemories(exec: Executor, userId: string): Promise<MemoryExport> {
  const memoryRows = await exec.rows("SELECT * FROM cognitive_records WHERE user_id = $1 ORDER BY created_time ASC, record_id ASC", [userId]);
  const evidenceRows = await exec.rows("SELECT * FROM memory_evidence WHERE user_id = $1 ORDER BY observed_at ASC, id ASC", [userId]);
  const operationRows = await exec.rows("SELECT * FROM memory_operations WHERE user_id = $1 ORDER BY created_at ASC, id ASC", [userId]);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    userId,
    memories: memoryRows.map(cognitiveRowToRecord),
    evidence: evidenceRows.map(evidenceRowToRecord),
    operations: operationRows.map(operationRowToRecord),
  };
}

export async function importMemories(exec: Executor, userId: string, data: MemoryImport): Promise<ImportResult> {
  let importedMemories = 0;
  let importedEvidence = 0;
  let importedOperations = 0;
  await exec.tx(async (client) => {
    const chunkChars = readImportChunkChars();
    const memories = (data.memories ?? []).flatMap((r) => expandImportRecord(r, chunkChars));
    for (const record of memories) {
      await upsertCognitiveMeta(client, { ...record, userId });
      await replaceFileIndexTx(client, { ...record, userId });
      importedMemories++;
    }
    for (const ev of data.evidence ?? []) {
      await client.query(
        `INSERT INTO memory_evidence (id, user_id, record_id, kind, ref, excerpt, observed_at, metadata_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           kind=EXCLUDED.kind, ref=EXCLUDED.ref, excerpt=EXCLUDED.excerpt,
           observed_at=EXCLUDED.observed_at, metadata_json=EXCLUDED.metadata_json`,
        [ev.id, userId, ev.recordId, ev.kind, ev.ref, ev.excerpt, ev.observedAt, JSON.stringify(ev.metadata ?? {})],
      );
      importedEvidence++;
    }
    for (const op of data.operations ?? []) {
      await client.query(
        `INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO NOTHING`,
        [op.id, userId, op.recordId, op.operation, op.actor, op.sessionKey, op.reason, op.createdAt, JSON.stringify(op.metadata ?? {})],
      );
      importedOperations++;
    }
    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
       VALUES ($1,$2,NULL,'import','system','','',$3,$4)`,
      [randomUUID(), userId, now, JSON.stringify({ importedMemories, importedEvidence, importedOperations })],
    );
  });
  return { importedMemories, importedEvidence, importedOperations };
}

export async function hardDeleteMemory(exec: Executor, userId: string, recordId: string, reason: string): Promise<void> {
  const now = new Date().toISOString();
  await exec.tx(async (client) => {
    await client.query("DELETE FROM memory_evidence WHERE user_id = $1 AND record_id = $2", [userId, recordId]);
    await client.query("DELETE FROM memory_file_index WHERE user_id = $1 AND record_id = $2", [userId, recordId]);
    // cognitive_vec has no user_id column (record-id keyed); delete by id.
    await client.query("DELETE FROM cognitive_vec WHERE record_id = $1", [recordId]).catch(() => undefined);
    await client.query("DELETE FROM cognitive_records WHERE user_id = $1 AND record_id = $2", [userId, recordId]);
    await client.query(
      `INSERT INTO memory_operations (id, user_id, record_id, operation, actor, session_key, reason, created_at, metadata_json)
       VALUES ($1,$2,$3,'governance_delete','system','',$4,$5,'{}')`,
      [randomUUID(), userId, recordId, reason, now],
    );
  });
}

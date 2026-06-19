/**
 * ADR-004 Phase 3 — memory_jobs queue capability (BRAIN-P1).
 *
 * Extracted VERBATIM from `SqliteMemoryStore` (1/10 coupling: own `memory_jobs`
 * table via `this.db`; the only cross-method call, `getMemoryJob`, is in-group).
 * `SqliteMemoryStore` composes one of these and delegates. JOB_COLUMNS moved
 * here with the group (it was used only by these queries).
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type {
  MemoryJobEnqueueInput,
  MemoryJobKindAggregate,
  MemoryJobListFilters,
  MemoryJobRecord,
  MemoryJobStatus,
} from "@kinqs/brainrouter-types";
import { jobRowToRecord } from "./converters.js";

const JOB_COLUMNS =
  "id, kind, status, priority, attempts, max_attempts, run_after, locked_at, parent_job_id, input_json, output_json, error, created_at, updated_at";

export class SqliteJobsStore {
  constructor(private readonly db: DatabaseSync) {}

  public enqueueMemoryJob(
    input: MemoryJobEnqueueInput,
    options?: { idGenerator?: () => string; now?: string },
  ): MemoryJobRecord {
    const now = options?.now ?? new Date().toISOString();
    const id = (options?.idGenerator ?? (() => randomUUID()))();
    const runAfter = input.runAfter ?? now;
    const priority = input.priority ?? 50;
    const maxAttempts = input.maxAttempts ?? 3;
    this.db
      .prepare(
        `INSERT INTO memory_jobs
           (id, kind, status, priority, attempts, max_attempts, run_after, locked_at,
            parent_job_id, input_json, output_json, error, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, 0, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        priority,
        maxAttempts,
        runAfter,
        input.parentJobId ?? null,
        JSON.stringify(input.input ?? {}),
        now,
        now,
      );
    return this.getMemoryJob(id)!;
  }

  public getMemoryJob(id: string): MemoryJobRecord | null {
    const row = this.db
      .prepare(`SELECT ${JOB_COLUMNS} FROM memory_jobs WHERE id = ?`)
      .get(id) as any;
    return row ? jobRowToRecord(row) : null;
  }

  public listMemoryJobs(filters?: MemoryJobListFilters): MemoryJobRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filters?.kind) {
      where.push("kind = ?");
      params.push(filters.kind);
    }
    if (filters?.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      if (statuses.length > 0) {
        where.push(`status IN (${statuses.map(() => "?").join(",")})`);
        params.push(...statuses);
      }
    }
    const limit = filters?.limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM memory_jobs
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY priority DESC, created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(...params, limit) as any[];
    return rows.map(jobRowToRecord);
  }

  public claimNextMemoryJob(options?: { now?: string }): MemoryJobRecord | null {
    const now = options?.now ?? new Date().toISOString();
    // BEGIN IMMEDIATE takes the write lock up front so two federated
    // brain processes can't both claim the same row. The select-then-
    // update is one transaction; under WAL a second claimant blocks on
    // the write lock (busy_timeout) rather than racing.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.db
        .prepare(
          `SELECT id FROM memory_jobs
           WHERE status = 'pending' AND run_after <= ?
           ORDER BY priority DESC, run_after ASC, id ASC
           LIMIT 1`,
        )
        .get(now) as { id: string } | undefined;
      if (!candidate) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare(
          `UPDATE memory_jobs
           SET status = 'running', locked_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(now, now, candidate.id);
      this.db.exec("COMMIT");
      return this.getMemoryJob(candidate.id);
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }

  public startMemoryJob(id: string, options?: { now?: string }): MemoryJobRecord | null {
    const now = options?.now ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_jobs
         SET status = 'running', locked_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, now, id);
    if (Number(result.changes ?? 0) === 0) return null;
    return this.getMemoryJob(id);
  }

  public completeMemoryJob(
    id: string,
    output: unknown,
    options?: { now?: string },
  ): MemoryJobRecord | null {
    const now = options?.now ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_jobs
         SET status = 'done', output_json = ?, error = NULL, locked_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(JSON.stringify(output ?? null), now, id);
    if (Number(result.changes ?? 0) === 0) return null;
    return this.getMemoryJob(id);
  }

  public failMemoryJob(
    id: string,
    error: string,
    options?: { now?: string; backoffMs?: number },
  ): MemoryJobRecord | null {
    const now = options?.now ?? new Date().toISOString();
    const job = this.getMemoryJob(id);
    if (!job || job.status !== "running") return null;
    const attempts = job.attempts + 1;
    if (attempts < job.maxAttempts) {
      const runAfter = new Date(Date.parse(now) + (options?.backoffMs ?? 0)).toISOString();
      this.db
        .prepare(
          `UPDATE memory_jobs
           SET status = 'pending', attempts = ?, error = ?, run_after = ?, locked_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(attempts, error, runAfter, now, id);
    } else {
      this.db
        .prepare(
          `UPDATE memory_jobs
           SET status = 'failed', attempts = ?, error = ?, locked_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(attempts, error, now, id);
    }
    return this.getMemoryJob(id);
  }

  public retryMemoryJob(id: string, options?: { now?: string }): MemoryJobRecord | null {
    const now = options?.now ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_jobs
         SET status = 'pending', attempts = 0, run_after = ?, locked_at = NULL, error = NULL, updated_at = ?
         WHERE id = ? AND status IN ('failed', 'cancelled')`,
      )
      .run(now, now, id);
    if (Number(result.changes ?? 0) === 0) {
      // No-op for pending/running/done — return the current row if it exists.
      return this.getMemoryJob(id);
    }
    return this.getMemoryJob(id);
  }

  public cancelMemoryJob(id: string, options?: { now?: string; reason?: string }): MemoryJobRecord | null {
    const now = options?.now ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_jobs
         SET status = 'cancelled', error = COALESCE(?, error), locked_at = NULL, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'running')`,
      )
      .run(options?.reason ?? null, now, id);
    if (Number(result.changes ?? 0) === 0) return this.getMemoryJob(id);
    return this.getMemoryJob(id);
  }

  public sweepStuckMemoryJobs(stuckMs: number, options?: { now?: string }): number {
    const now = options?.now ?? new Date().toISOString();
    const cutoff = new Date(Date.parse(now) - stuckMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_jobs
         SET status = 'cancelled', error = 'swept: lock expired', locked_at = NULL, updated_at = ?
         WHERE status = 'running' AND locked_at IS NOT NULL AND locked_at < ?`,
      )
      .run(now, cutoff);
    return Number(result.changes ?? 0);
  }

  public getMemoryJobKindAggregates(options?: { now?: string }): MemoryJobKindAggregate[] {
    const now = options?.now ?? new Date().toISOString();
    const since24h = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
    const kinds = (
      this.db.prepare("SELECT DISTINCT kind FROM memory_jobs ORDER BY kind ASC").all() as Array<{
        kind: string;
      }>
    ).map((r) => r.kind);

    return kinds.map((kind) => {
      const latest = this.db
        .prepare(
          `SELECT status, updated_at FROM memory_jobs
           WHERE kind = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
        )
        .get(kind) as { status: string; updated_at: string } | undefined;
      const lastCompleted = this.db
        .prepare(
          `SELECT updated_at FROM memory_jobs
           WHERE kind = ? AND status = 'done' ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(kind) as { updated_at: string } | undefined;
      const pending = this.db
        .prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = ? AND status = 'pending'")
        .get(kind) as { n: number };
      const terminal = this.db
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
           FROM memory_jobs
           WHERE kind = ? AND updated_at >= ? AND status IN ('done', 'failed')`,
        )
        .get(kind, since24h) as { done: number | null; failed: number | null };
      const done = Number(terminal.done ?? 0);
      const failed = Number(terminal.failed ?? 0);
      const total = done + failed;
      return {
        kind,
        lastStatus: (latest?.status ?? "pending") as MemoryJobStatus,
        lastCompletedAt: lastCompleted?.updated_at ?? null,
        pendingJobs: Number(pending.n ?? 0),
        successRate24h: total > 0 ? done / total : null,
      };
    });
  }
}

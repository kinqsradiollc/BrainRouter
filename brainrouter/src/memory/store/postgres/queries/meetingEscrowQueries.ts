/**
 * ADR-035 D11 — capture-escrow persistence (migration 062).
 *
 * A browser's capture store can be evicted mid-recording, so the transcript of an
 * in-progress capture is escrowed here as it settles. The rows hold TEXT, never audio.
 *
 * Every statement is keyed by `org_id` AND `user_id`. An escrowed capture is a meeting
 * nobody has filed yet — the most private thing this table could hold — so there is no
 * read path here that a session id alone can reach, and no update path that takes an
 * owner from the payload rather than from the authenticated request. Exposed via thin
 * PostgresMemoryStore methods, consumed by memory/meetings/escrow.ts.
 */
import type { Executor } from "./executor.js";

export interface MeetingEscrowRow {
  sessionId: string;
  title: string;
  template: string;
  language: string;
  transcript: string;
  coverageMs: number;
  retentionDays: number;
  startedAt: string;
  updatedAt: string;
}

export interface UpsertMeetingEscrowInput {
  sessionId: string;
  title: string;
  template: string;
  language: string;
  transcript: string;
  coverageMs: number;
  retentionDays: number;
  startedAt: string;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}

function mapRow(r: Record<string, unknown>): MeetingEscrowRow {
  return {
    sessionId: String(r.session_id),
    title: String(r.title ?? ""),
    template: String(r.template ?? "general"),
    language: String(r.language ?? ""),
    transcript: String(r.transcript ?? ""),
    coverageMs: Number(r.coverage_ms ?? 0),
    retentionDays: Number(r.retention_days ?? 30),
    startedAt: iso(r.started_at),
    updatedAt: iso(r.updated_at),
  };
}

/**
 * Write what the device has now.
 *
 * A whole-row upsert rather than an append, because the client's transcript IS the
 * record: segments settle out of order, a retry rewrites one that already landed, and a
 * person edits settled text in the compose box. Appending deltas here would make the
 * server hold a version of the meeting the device never had.
 *
 * `started_at` is not updated on conflict — it is the identity of the recording, and a
 * later push must not be able to move a capture's retention clock forward.
 */
export async function upsertMeetingEscrow(exec: Executor, orgId: string, userId: string, input: UpsertMeetingEscrowInput): Promise<void> {
  await exec.run(
    `INSERT INTO meeting_capture_escrow
       (org_id, user_id, session_id, title, template, language, transcript, coverage_ms, retention_days, started_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (org_id, user_id, session_id) DO UPDATE SET
       title = EXCLUDED.title,
       template = EXCLUDED.template,
       language = EXCLUDED.language,
       transcript = EXCLUDED.transcript,
       coverage_ms = EXCLUDED.coverage_ms,
       retention_days = EXCLUDED.retention_days,
       updated_at = now()`,
    [orgId, userId, input.sessionId, input.title, input.template, input.language, input.transcript, input.coverageMs, input.retentionDays, input.startedAt],
  );
}

/** Everything this person has open in this workspace, newest recording first. */
export async function listMeetingEscrow(exec: Executor, orgId: string, userId: string, limit: number): Promise<MeetingEscrowRow[]> {
  const rows = await exec.rows(
    `SELECT session_id, title, template, language, transcript, coverage_ms, retention_days, started_at, updated_at
       FROM meeting_capture_escrow
      WHERE org_id = $1 AND user_id = $2
      ORDER BY started_at DESC
      LIMIT $3`,
    [orgId, userId, limit],
  );
  return rows.map((row) => mapRow(row as Record<string, unknown>));
}

/** How many are already open — the bound on this path, checked before an INSERT widens it. */
export async function countMeetingEscrow(exec: Executor, orgId: string, userId: string): Promise<number> {
  const row = await exec.one(`SELECT COUNT(*)::int AS n FROM meeting_capture_escrow WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  return Number((row as { n?: unknown } | null)?.n ?? 0);
}

/** Whether this person already has this capture escrowed — an upsert that will not widen the count. */
export async function meetingEscrowExists(exec: Executor, orgId: string, userId: string, sessionId: string): Promise<boolean> {
  const row = await exec.one(
    `SELECT 1 AS ok FROM meeting_capture_escrow WHERE org_id = $1 AND user_id = $2 AND session_id = $3`,
    [orgId, userId, sessionId],
  );
  return row != null;
}

/** D6/D11 — the capture is filed or thrown away; the server's copy goes with it. */
export async function deleteMeetingEscrow(exec: Executor, orgId: string, userId: string, sessionId: string): Promise<boolean> {
  const changed = await exec.run(`DELETE FROM meeting_capture_escrow WHERE org_id = $1 AND user_id = $2 AND session_id = $3`, [orgId, userId, sessionId]);
  return changed > 0;
}

/**
 * D6 — delete what has outlived its own window, and say which.
 *
 * The window is per row because it is the one the person set on the device that made the
 * recording, so the comparison is done in SQL against each row's own `retention_days`
 * rather than against one number the caller chose. A row nobody has pushed for longer
 * than its window is deleted whether or not that device ever comes back, which is the
 * whole reason the server keeps a copy of the window at all.
 */
export async function deleteExpiredMeetingEscrow(exec: Executor, orgId: string, userId: string): Promise<string[]> {
  const rows = await exec.rows(
    `DELETE FROM meeting_capture_escrow
      WHERE org_id = $1 AND user_id = $2
        AND started_at < now() - make_interval(days => retention_days)
      RETURNING session_id`,
    [orgId, userId],
  );
  return rows.map((row) => String((row as Record<string, unknown>).session_id));
}

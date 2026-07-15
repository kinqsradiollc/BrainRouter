/**
 * Meetings persistence (ADR-018). The `meetings` index table holds display data +
 * links to the recallable memory records; `meeting_shares` holds revocable public tokens.
 * Owner-guarded writes (`user_id = $x`) prevent cross-user tampering, matching
 * memorySharingQueries. Exposed via thin PostgresMemoryStore methods.
 */
import type { Executor } from "./executor.js";

export type MeetingScope = "private" | "team" | "org" | "public";

export interface MeetingRow {
  id: string;
  orgId: string;
  userId: string;
  title: string;
  meetingDate: string | null;
  status: string;
  durationMin: number | null;
  wordCount: number | null;
  attendees: string[];
  transcriptText: string;
  summaryMarkdown: string;
  actionItems: Array<{ id: string; title: string; assignee?: string; done?: boolean; trackItemId?: string }>;
  summaryRecordId: string | null;
  transcriptSourceId: string | null;
  scope: MeetingScope;
  teamId: string | null;
  modelLabel: string | null;
  modelEffort: string | null;
  /** Notes-generation lifecycle, independent of the import `status`. */
  summaryStatus: "queued" | "processing" | "ready" | "failed";
  summaryError: string | null;
  createdAt: string;
}

export interface CreateMeetingInput {
  id: string;
  orgId: string;
  userId: string;
  title: string;
  meetingDate?: string;
  status?: string;
  durationMin?: number;
  wordCount?: number;
  attendees?: string[];
  transcriptText: string;
  summaryMarkdown: string;
  actionItems?: MeetingRow["actionItems"];
  summaryRecordId?: string;
  transcriptSourceId?: string;
  scope?: MeetingScope;
  teamId?: string;
  modelLabel?: string;
  modelEffort?: string;
  summaryStatus?: "queued" | "processing" | "ready" | "failed";
}

function mapRow(r: Record<string, unknown>): MeetingRow {
  const parse = <T>(v: unknown, fallback: T): T => {
    if (typeof v !== "string") return fallback;
    try { return JSON.parse(v) as T; } catch { return fallback; }
  };
  return {
    id: String(r.id), orgId: String(r.org_id), userId: String(r.user_id), title: String(r.title),
    meetingDate: r.meeting_date == null ? null : String(r.meeting_date),
    status: String(r.status ?? "recorded"),
    durationMin: r.duration_min == null ? null : Number(r.duration_min),
    wordCount: r.word_count == null ? null : Number(r.word_count),
    attendees: parse<string[]>(r.attendees_json, []),
    transcriptText: String(r.transcript_text ?? ""),
    summaryMarkdown: String(r.summary_markdown ?? ""),
    actionItems: parse<MeetingRow["actionItems"]>(r.action_items_json, []),
    summaryRecordId: r.summary_record_id == null ? null : String(r.summary_record_id),
    transcriptSourceId: r.transcript_source_id == null ? null : String(r.transcript_source_id),
    scope: String(r.scope ?? "private") as MeetingScope,
    teamId: r.team_id == null ? null : String(r.team_id),
    modelLabel: r.model_label == null ? null : String(r.model_label),
    modelEffort: r.model_effort == null ? null : String(r.model_effort),
    summaryStatus: (["queued", "processing", "ready", "failed"].includes(String(r.summary_status))
      ? String(r.summary_status) : "ready") as MeetingRow["summaryStatus"],
    summaryError: r.summary_error == null ? null : String(r.summary_error),
    createdAt: String(r.created_at ?? ""),
  };
}

export async function createMeeting(exec: Executor, m: CreateMeetingInput): Promise<void> {
  await exec.run(
    `INSERT INTO meetings (id, org_id, user_id, title, meeting_date, status, duration_min, word_count,
       attendees_json, transcript_text, summary_markdown, action_items_json, summary_record_id,
       transcript_source_id, scope, team_id, model_label, model_effort, summary_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [m.id, m.orgId, m.userId, m.title, m.meetingDate ?? null, m.status ?? "recorded",
      m.durationMin ?? null, m.wordCount ?? null, JSON.stringify(m.attendees ?? []), m.transcriptText,
      m.summaryMarkdown, JSON.stringify(m.actionItems ?? []), m.summaryRecordId ?? null,
      m.transcriptSourceId ?? null, m.scope ?? "private", m.teamId ?? null, m.modelLabel ?? null,
      m.modelEffort ?? null, m.summaryStatus ?? "ready"],
  );
}

/** Set the notes-generation lifecycle status (owner-guarded). `error` is only
 *  meaningful for 'failed'; it is cleared on any other status. */
export async function setMeetingSummaryStatus(
  exec: Executor, id: string, userId: string,
  status: MeetingRow["summaryStatus"], error?: string | null,
): Promise<boolean> {
  const n = await exec.run(
    `UPDATE meetings SET summary_status = $3, summary_error = $4, summary_updated_at = now(), updated_at = now()
       WHERE id = $1 AND user_id = $2`,
    [id, userId, status, status === "failed" ? (error ?? "Summary generation failed.") : null],
  );
  return n > 0;
}

/** Meetings the user may see: their own, plus org/public/team-shared within the org. */
export async function listMeetings(exec: Executor, orgId: string, userId: string, limit = 100): Promise<MeetingRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT * FROM meetings
      WHERE org_id = $1 AND (user_id = $2 OR scope IN ('team','org','public'))
      ORDER BY created_at DESC LIMIT $3`,
    [orgId, userId, limit],
  );
  return rows.map(mapRow);
}

export async function getMeeting(exec: Executor, orgId: string, userId: string, id: string): Promise<MeetingRow | null> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT * FROM meetings
      WHERE id = $1 AND org_id = $2 AND (user_id = $3 OR scope IN ('team','org','public')) LIMIT 1`,
    [id, orgId, userId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Owner-only scope change. Returns true when a row was updated. */
export async function setMeetingScope(exec: Executor, id: string, userId: string, scope: MeetingScope, teamId: string | null): Promise<boolean> {
  const n = await exec.run(
    `UPDATE meetings SET scope = $3, team_id = $4, updated_at = now() WHERE id = $1 AND user_id = $2`,
    [id, userId, scope, teamId],
  );
  return n > 0;
}

export async function createShareToken(exec: Executor, s: { token: string; meetingId: string; orgId: string; createdBy: string; expiresAt?: string }): Promise<void> {
  await exec.run(
    `INSERT INTO meeting_shares (token, meeting_id, org_id, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [s.token, s.meetingId, s.orgId, s.createdBy, s.expiresAt ?? null],
  );
}

export async function revokeShareTokens(exec: Executor, meetingId: string): Promise<number> {
  return exec.run(
    `UPDATE meeting_shares SET revoked_at = now() WHERE meeting_id = $1 AND revoked_at IS NULL`,
    [meetingId],
  );
}

/** Owner-only summary rewrite (regenerate). Returns true when a row updated. */
export async function updateMeetingSummary(exec: Executor, id: string, userId: string, summaryMarkdown: string, actionItems: MeetingRow["actionItems"]): Promise<boolean> {
  const n = await exec.run(
    `UPDATE meetings SET summary_markdown = $3, action_items_json = $4, summary_status = 'ready',
       summary_error = NULL, summary_updated_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2`,
    [id, userId, summaryMarkdown, JSON.stringify(actionItems)],
  );
  return n > 0;
}

/** Owner-only: link the recall provenance records written by the background pass. */
export async function setMeetingSummaryRecords(exec: Executor, id: string, userId: string, summaryRecordId: string | null, transcriptSourceId: string | null): Promise<boolean> {
  const n = await exec.run(
    `UPDATE meetings SET summary_record_id = COALESCE($3, summary_record_id),
       transcript_source_id = COALESCE($4, transcript_source_id), updated_at = now()
       WHERE id = $1 AND user_id = $2`,
    [id, userId, summaryRecordId, transcriptSourceId],
  );
  return n > 0;
}

/** Owner-only action-item state write (done toggles / track links persist). */
export async function updateMeetingActionItems(exec: Executor, id: string, userId: string, actionItems: MeetingRow["actionItems"]): Promise<boolean> {
  const n = await exec.run(
    `UPDATE meetings SET action_items_json = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
    [id, userId, JSON.stringify(actionItems)],
  );
  return n > 0;
}

/** The current active public token for a meeting (newest), if any. */
export async function getActiveShareToken(exec: Executor, meetingId: string): Promise<{ token: string; expiresAt: string | null } | null> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT token, expires_at FROM meeting_shares
      WHERE meeting_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC LIMIT 1`,
    [meetingId],
  );
  const r = rows[0];
  return r ? { token: String(r.token), expiresAt: r.expires_at == null ? null : String(r.expires_at) } : null;
}

/** Public read: the meeting for an active (not revoked/expired) share token. */
export async function getMeetingByShareToken(exec: Executor, token: string): Promise<MeetingRow | null> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT m.* FROM meeting_shares s JOIN meetings m ON m.id = s.meeting_id
      WHERE s.token = $1 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now()) LIMIT 1`,
    [token],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

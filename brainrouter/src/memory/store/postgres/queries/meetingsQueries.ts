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

export interface MeetingTranscriptSegment { ordinal: number; at: string; speaker: string; text: string; total?: number }
export interface MeetingListCursor { createdAt: string; id: string }

/**
 * Access is deliberately expressed once and reused by every authenticated read:
 * - owner/org/public reads stay inside the active organization;
 * - organization-team reads require membership and the same organization;
 * - personal-team reads require membership and may cross organization boundaries.
 */
function accessible(alias: string, orgParam: string, userParam: string): string {
  return `(
    (${alias}.org_id = ${orgParam} AND (${alias}.user_id = ${userParam} OR ${alias}.scope IN ('org','public')))
    OR (${alias}.scope = 'team' AND EXISTS (
      SELECT 1 FROM teams access_team
      JOIN team_members access_member ON access_member.team_id = access_team.id
      WHERE access_team.id = ${alias}.team_id AND access_member.user_id = ${userParam}
        AND (access_team.kind = 'personal'
          OR (access_team.kind = 'organization' AND access_team.org_id = ${orgParam} AND ${alias}.org_id = ${orgParam}))
    ))
  )`;
}

function transcriptSegments(text: string): MeetingTranscriptSegment[] {
  const segments: MeetingTranscriptSegment[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const timestamp = trimmed.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+)$/);
    segments.push({ ordinal: segments.length, at: timestamp?.[1] ?? "", speaker: "", text: (timestamp?.[2] ?? trimmed).trim() });
  }
  return segments;
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
  const segments = transcriptSegments(m.transcriptText);
  await exec.tx(async (client) => {
    await client.query(
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
    if (segments.length) {
      await client.query(
        `INSERT INTO meeting_transcript_segments (meeting_id, ordinal, at_label, speaker, text)
         SELECT $1, (segment ->> 'ordinal')::integer, segment ->> 'at', segment ->> 'speaker', segment ->> 'text'
           FROM jsonb_array_elements($2::jsonb) AS segment
         ON CONFLICT (meeting_id, ordinal) DO NOTHING`,
        [m.id, JSON.stringify(segments)],
      );
    }
  });
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
  return listMeetingsPage(exec, orgId, userId, limit);
}

export async function listMeetingsPage(exec: Executor, orgId: string, userId: string, limit = 100, cursor?: MeetingListCursor): Promise<MeetingRow[]> {
  const params: unknown[] = [orgId, userId];
  const cursorWhere = cursor ? "AND (m.created_at, m.id) < ($3, $4)" : "";
  if (cursor) params.push(cursor.createdAt, cursor.id);
  params.push(limit);
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT m.id, m.org_id, m.user_id, m.title, m.meeting_date, m.status, m.duration_min, m.word_count,
            m.attendees_json, m.scope, m.team_id, m.model_label, m.model_effort, m.summary_status,
            m.summary_error, m.created_at
       FROM meetings m
      WHERE ${accessible("m", "$1", "$2")} ${cursorWhere}
      ORDER BY m.created_at DESC, m.id DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapRow);
}

/** Summary/action projection for progressive dashboard detail. */
export async function getMeetingOverview(exec: Executor, orgId: string, userId: string, id: string): Promise<MeetingRow | null> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT id, org_id, user_id, title, meeting_date, status, duration_min, word_count,
            attendees_json, summary_markdown, action_items_json, summary_record_id,
            transcript_source_id, scope, team_id, model_label, model_effort,
            summary_status, summary_error, created_at
       FROM meetings m
      WHERE m.id = $1 AND ${accessible("m", "$2", "$3")} LIMIT 1`,
    [id, orgId, userId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Transcript-only projection; the API turns it into bounded pages. */
export async function getMeetingTranscriptText(exec: Executor, orgId: string, userId: string, id: string): Promise<string | null> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT m.transcript_text FROM meetings m
      WHERE m.id = $1 AND ${accessible("m", "$2", "$3")} LIMIT 1`,
    [id, orgId, userId],
  );
  return rows[0] ? String(rows[0].transcript_text ?? "") : null;
}

export async function insertMeetingTranscriptSegments(exec: Executor, meetingId: string, segments: MeetingTranscriptSegment[]): Promise<void> {
  if (!segments.length) return;
  await exec.run(
    `INSERT INTO meeting_transcript_segments (meeting_id, ordinal, at_label, speaker, text)
     SELECT $1, (segment ->> 'ordinal')::integer, segment ->> 'at', segment ->> 'speaker', segment ->> 'text'
       FROM jsonb_array_elements($2::jsonb) AS segment
     ON CONFLICT (meeting_id, ordinal) DO NOTHING`,
    [meetingId, JSON.stringify(segments)],
  );
}

export async function listMeetingTranscriptSegments(exec: Executor, orgId: string, userId: string, id: string, cursor = 0, limit = 100): Promise<MeetingTranscriptSegment[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `WITH accessible AS (
       SELECT s.ordinal, s.at_label, s.speaker, s.text
         FROM meeting_transcript_segments s
         JOIN meetings m ON m.id = s.meeting_id
        WHERE m.id = $1 AND ${accessible("m", "$2", "$3")}
     ), counted AS (
       SELECT *, COUNT(*) OVER() AS total FROM accessible
     )
     SELECT * FROM counted WHERE ordinal >= $4 ORDER BY ordinal ASC LIMIT $5`,
    [id, orgId, userId, cursor, limit],
  );
  return rows.map((row) => ({ ordinal: Number(row.ordinal), at: String(row.at_label ?? ""), speaker: String(row.speaker ?? ""), text: String(row.text ?? ""), total: Number(row.total ?? 0) }));
}

export async function getMeeting(exec: Executor, orgId: string, userId: string, id: string): Promise<MeetingRow | null> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT m.* FROM meetings m
      WHERE m.id = $1 AND ${accessible("m", "$2", "$3")} LIMIT 1`,
    [id, orgId, userId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Owner-only scope change. Returns true when a row was updated. */
export async function setMeetingScope(exec: Executor, id: string, orgId: string, userId: string, scope: MeetingScope, teamId: string | null): Promise<boolean> {
  const n = await exec.run(
    `UPDATE meetings SET scope = $4, team_id = $5, updated_at = now() WHERE id = $1 AND org_id = $2 AND user_id = $3`,
    [id, orgId, userId, scope, teamId],
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

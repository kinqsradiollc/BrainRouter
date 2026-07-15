import { describe, expect, it, vi } from "vitest";
import { getMeetingOverview, getMeetingTranscriptText, listMeetings, listMeetingsPage, listMeetingTranscriptSegments } from "./meetingsQueries.js";

function executor() {
  return { rows: vi.fn(async () => []) } as any;
}

describe("meeting dashboard projections", () => {
  it("does not select transcript, summary, or action bodies for the list", async () => {
    const exec = executor();
    await listMeetings(exec, "org-1", "user-1");
    const [sql] = exec.rows.mock.calls[0]!;
    expect(sql).not.toContain("SELECT *");
    expect(sql).not.toContain("transcript_text");
    expect(sql).not.toContain("summary_markdown");
    expect(sql).not.toContain("action_items_json");
  });

  it("uses a stable keyset cursor for subsequent meeting list pages", async () => {
    const exec = executor();
    await listMeetingsPage(exec, "org-1", "user-1", 51, { createdAt: "2026-07-15T00:00:00.000Z", id: "meeting-9" });
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("(created_at, id) < ($3, $4)");
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(params).toEqual(["org-1", "user-1", "2026-07-15T00:00:00.000Z", "meeting-9", 51]);
  });

  it("pages normalized transcript segments through an access-scoped query", async () => {
    const exec = executor();
    await listMeetingTranscriptSegments(exec, "org-1", "user-1", "meeting-1", 100, 101);
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("meeting_transcript_segments");
    expect(sql).toContain("m.org_id = $2");
    expect(sql).toContain("ordinal >= $4");
    expect(params).toEqual(["meeting-1", "org-1", "user-1", 100, 101]);
  });

  it("loads overview and transcript through separate projections", async () => {
    const exec = executor();
    await getMeetingOverview(exec, "org-1", "user-1", "meeting-1");
    await getMeetingTranscriptText(exec, "org-1", "user-1", "meeting-1");
    const overviewSql = exec.rows.mock.calls[0]![0] as string;
    const transcriptSql = exec.rows.mock.calls[1]![0] as string;
    expect(overviewSql).toContain("summary_markdown");
    expect(overviewSql).not.toContain("transcript_text");
    expect(transcriptSql).toContain("SELECT transcript_text");
    expect(transcriptSql).not.toContain("summary_markdown");
  });
});

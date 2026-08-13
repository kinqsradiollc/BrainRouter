/**
 * ADR-035 D11 — the escrow's SQL, checked for the properties that are invisible from the
 * backend above it: that no statement can reach a row without both the org and the user,
 * that an update cannot move a recording's retention clock, and that the sweep compares
 * each row against its own window rather than one the caller chose.
 */
import { describe, expect, it, vi } from "vitest";

import {
  countMeetingEscrow,
  deleteExpiredMeetingEscrow,
  deleteMeetingEscrow,
  listMeetingEscrow,
  upsertMeetingEscrow,
} from "./meetingEscrowQueries.js";

function executor() {
  return { rows: vi.fn(async () => []), one: vi.fn(async () => null), run: vi.fn(async () => 1) } as any;
}

const INPUT = {
  sessionId: "mtg-1",
  title: "Planning",
  template: "standup",
  language: "en",
  transcript: "words",
  coverageMs: 1_000,
  retentionDays: 7,
  startedAt: "2026-08-12T09:00:00.000Z",
};

describe("meeting capture escrow queries", () => {
  it("keys every statement by org AND user", async () => {
    const exec = executor();
    await upsertMeetingEscrow(exec, "org-1", "user-1", INPUT);
    await listMeetingEscrow(exec, "org-1", "user-1", 50);
    await countMeetingEscrow(exec, "org-1", "user-1");
    await deleteMeetingEscrow(exec, "org-1", "user-1", "mtg-1");
    await deleteExpiredMeetingEscrow(exec, "org-1", "user-1");
    // Every READ and every DELETE is filtered by both, so there is no statement a session
    // id alone can reach a row through.
    const filtered = [
      exec.rows.mock.calls[0]![0] as string,
      exec.one.mock.calls[0]![0] as string,
      exec.run.mock.calls[1]![0] as string,
      exec.rows.mock.calls[1]![0] as string,
    ];
    for (const sql of filtered) {
      expect(sql).toContain("org_id = $1");
      expect(sql).toContain("user_id = $2");
    }
    // The INSERT carries them positionally, from the authenticated request rather than
    // from the payload — and the conflict target is the whole triple, so one person's
    // push can never overwrite another's capture of the same name.
    const [insert, insertParams] = exec.run.mock.calls[0]!;
    expect(insert as string).toContain("(org_id, user_id, session_id");
    expect(insert as string).toContain("ON CONFLICT (org_id, user_id, session_id)");
    expect((insertParams as unknown[]).slice(0, 2)).toEqual(["org-1", "user-1"]);
  });

  it("does not let a later push move the recording's start, and so its retention clock", async () => {
    const exec = executor();
    await upsertMeetingEscrow(exec, "org-1", "user-1", INPUT);
    const [sql, params] = exec.run.mock.calls[0]!;
    expect(sql).toContain("ON CONFLICT (org_id, user_id, session_id) DO UPDATE SET");
    expect(sql).not.toContain("started_at = EXCLUDED.started_at");
    expect(sql).toContain("transcript = EXCLUDED.transcript");
    expect(params).toEqual(["org-1", "user-1", "mtg-1", "Planning", "standup", "en", "words", 1_000, 7, "2026-08-12T09:00:00.000Z"]);
  });

  it("sweeps each row against its OWN window and reports what it deleted", async () => {
    const exec = executor();
    await deleteExpiredMeetingEscrow(exec, "org-1", "user-1");
    const [sql] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("DELETE FROM meeting_capture_escrow");
    expect(sql).toContain("make_interval(days => retention_days)");
    expect(sql).toContain("RETURNING session_id");
  });

  it("lists newest recording first and bounds the page", async () => {
    const exec = executor();
    await listMeetingEscrow(exec, "org-1", "user-1", 50);
    const [sql, params] = exec.rows.mock.calls[0]!;
    expect(sql).toContain("ORDER BY started_at DESC");
    expect(sql).toContain("LIMIT $3");
    expect(params).toEqual(["org-1", "user-1", 50]);
  });
});

/**
 * ADR-049 (completion) — the full generation-source set (meeting / track / rules
 * added to text / doc / decisions / atlas) and the once-daily reminder expressed
 * in the existing schedule store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { profileGenerationSources, type StudySourceKind } from "../study/generate.js";
import {
  buildStudyReminderSchedule, findStudyReminder, studyReminderHour,
  studyReminderState, shouldNudge, nextDailyRun, STUDY_REMINDER_COMMAND,
} from "../study/reminder.js";
import { addSchedule, loadSchedules, type ScheduleRecord } from "../schedule/scheduleStore.js";
import { isoDay } from "../study/srs.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALL: StudySourceKind[] = ["text", "document", "doc", "decisions", "rules", "atlas", "track", "meeting"];

test("every profile can reach every source; the order leads, never gates", () => {
  for (const profile of ["engineering", "research", "study", "product-management", "custom", "sales", "finance"]) {
    const kinds = profileGenerationSources(profile).map((s) => s.kind);
    assert.equal(new Set(kinds).size, kinds.length, `${profile}: no duplicate sources`);
    for (const k of ALL) assert.ok(kinds.includes(k), `${profile} can reach ${k}`);
  }
});

test("profile shapes the lead source (D2); readings lead for study/research", () => {
  assert.equal(profileGenerationSources("engineering")[0]!.kind, "decisions");
  assert.equal(profileGenerationSources("product-management")[0]!.kind, "meeting");
  // ADR-030 documents (readings) lead where a person studies material.
  assert.equal(profileGenerationSources("research")[0]!.kind, "document");
  assert.equal(profileGenerationSources("study")[0]!.kind, "document");
  // An unknown profile still gets a usable generic order led by paste.
  assert.equal(profileGenerationSources("nope")[0]!.kind, "text");
});

test("reminder: schedule shape is a daily cron with the study marker command", () => {
  const now = new Date(2026, 7, 25, 14, 30); // local 14:30
  const input = buildStudyReminderSchedule({ owner: "s1", hour: 9 }, now);
  assert.equal(input.kind, "cron");
  assert.equal(input.expr, "0 9 * * *");
  assert.equal(input.command, STUDY_REMINDER_COMMAND);
  // Today's 9am already passed → next run is TOMORROW at local 9am (TZ-robust:
  // compare the parsed local date/hour, not the UTC ISO prefix).
  const past = new Date(input.nextRun);
  assert.equal(past.getHours(), 9);
  assert.equal(isoDay(past), isoDay(new Date(2026, 7, 26)));
  // A future hour today → next run is today at that hour.
  const future = new Date(buildStudyReminderSchedule({ owner: "s1", hour: 20 }, now).nextRun);
  assert.equal(future.getHours(), 20);
  assert.equal(isoDay(future), isoDay(now));
  // Hour clamps into range.
  assert.equal(buildStudyReminderSchedule({ owner: "s1", hour: 99 }, now).expr, "0 23 * * *");
});

test("reminder: find + hour + state round-trip through the real schedule store", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "study-rem-"));
  process.env.BRAINROUTER_HOME = ws;
  try {
    assert.equal(studyReminderState(loadSchedules(ws)).enabled, false);
    addSchedule(ws, buildStudyReminderSchedule({ owner: "s1", hour: 8 }, new Date()));
    const schedules = loadSchedules(ws);
    const rec = findStudyReminder(schedules);
    assert.ok(rec, "reminder record present");
    assert.equal(studyReminderHour(rec), 8);
    assert.deepEqual(studyReminderState(schedules), { enabled: true, hour: 8 });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("shouldNudge: enabled + due + past-hour + not-yet-today", () => {
  const at = (h: number) => new Date(2026, 7, 25, h, 30);
  // Happy path: 10:30, reminder 9, 3 due, not nudged today.
  assert.equal(shouldNudge({ enabled: true, hour: 9, dueCount: 3 }, at(10)), true);
  // Before the hour → quiet.
  assert.equal(shouldNudge({ enabled: true, hour: 9, dueCount: 3 }, at(8)), false);
  // Nothing due → quiet.
  assert.equal(shouldNudge({ enabled: true, hour: 9, dueCount: 0 }, at(10)), false);
  // Already nudged today → quiet.
  assert.equal(shouldNudge({ enabled: true, hour: 9, dueCount: 3, lastNudgeDay: "2026-08-25" }, at(10)), false);
  // Disabled → quiet.
  assert.equal(shouldNudge({ enabled: false, hour: 9, dueCount: 3 }, at(10)), false);
});

test("nextDailyRun rolls to tomorrow only when the hour has passed", () => {
  const now = new Date(2026, 7, 25, 9, 0, 1); // local 09:00:01
  const passed = new Date(nextDailyRun(9, now));
  assert.equal(isoDay(passed), isoDay(new Date(2026, 7, 26)), "9:00:01 is past 9:00 → tomorrow");
  const soon = new Date(nextDailyRun(10, now));
  assert.equal(isoDay(soon), isoDay(now), "10:00 is still ahead → today");
});

// A record whose expr predates study reminders never crashes the parser.
test("studyReminderHour tolerates a malformed expr", () => {
  const rec = { command: STUDY_REMINDER_COMMAND, expr: "garbage" } as ScheduleRecord;
  assert.equal(studyReminderHour(rec), 9);
});

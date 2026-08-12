/**
 * ADR-035 D6 and D11 on the dashboard — the two promises about where a
 * recording lives, driven against the real store, the real session model and a
 * server the browser cannot wipe.
 *
 * The headline is §6's third D9–D11 criterion, and it is the last test in this
 * file: refuse persistence, record, EVICT the origin — and the meeting is still
 * recoverable, because the words are somewhere the origin's quota does not
 * reach. If that test passed with a louder warning instead, D11 was not built.
 *
 * The rest is D6's window: a sweep that really deletes, that spares a recording
 * somebody is making, and a number the person can change and see enforced.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { MEETING_RETENTION_DEFAULT_DAYS } from "@kinqs/brainrouter-core/meetings";

import { serializeCapturePayload } from "../../lib/meetings/capturePayload";
import { MEETING_RETENTION_CAPTURE_ID, readCaptureRetentionDays } from "../../lib/meetings/captureRetention";
import { MEETING_CAPTURE_TIMESLICE_MS, MeetingCaptureStore } from "../../lib/meetings/captureStore";
import { MEETING_DRAFT_CAPTURE_ID } from "../../lib/meetings/meetingDraft";
import { CaptureOrigin, flush, type CaptureTab } from "./_captureSurfaceHarness";

const DAY_MS = 86_400_000;

/** One D9 durability chunk — three seconds, which is what the recorder writes. */
async function chunk(tab: CaptureTab): Promise<void> {
  await tab.chunk(1_024, 7, MEETING_CAPTURE_TIMESLICE_MS);
}

/**
 * Record, land a transcribed unit, stop — one finished capture on the device.
 *
 * Eight chunks because a transcription UNIT is not a durability chunk (D9): text
 * exists once the unit seals, and an escrow with no words in it is deliberately
 * never written.
 */
async function recordOne(tab: CaptureTab): Promise<string> {
  await tab.record();
  for (let index = 0; index < 8; index += 1) await chunk(tab);
  await tab.stop();
  const sessionId = tab.state.session?.id ?? tab.state.recoverable[0]?.record.sessionId;
  assert.ok(sessionId, "a session exists from the press of Record");
  return sessionId;
}

/**
 * A capture as an OLD one: written directly through a store, so the record is
 * the shape a real one has and only its clock is a test's business.
 */
async function ageCapture(origin: CaptureOrigin, sessionId: string, startedDaysAgo: number): Promise<void> {
  const store = new MeetingCaptureStore(origin.backend);
  const at = new Date(origin.clock - startedDaysAgo * DAY_MS).toISOString();
  await store.begin({ sessionId, startedAt: at });
  await store.appendChunk(sessionId, new Blob([new Uint8Array(512).fill(3)]));
  await store.setPayload(sessionId, serializeCapturePayload({
    session: {
      id: sessionId,
      scope: { orgId: null },
      title: "an abandoned meeting",
      template: "general",
      status: "stopped",
      startedAt: at,
      stoppedAt: at,
      chunks: [{ sequence: 0, byteLength: 512, startMs: 0, endMs: 3_000 }],
      segments: [],
    },
    mimeType: "audio/webm",
  }));
}

test("D6 — the window has a default the ADR can name, and it is what an unset origin sweeps by", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  assert.equal(tab.state.retentionDays, MEETING_RETENTION_DEFAULT_DAYS);
  await ageCapture(origin, "mtg-old", MEETING_RETENTION_DEFAULT_DAYS + 1);
  await ageCapture(origin, "mtg-young", MEETING_RETENTION_DEFAULT_DAYS - 1);
  await tab.surface.refreshRecoverable();
  const left = (await origin.records()).map((record) => record.sessionId);
  assert.deepEqual(left, ["mtg-young"], "the expired capture is DELETED, not merely hidden");
  assert.ok((await origin.record("mtg-young"))?.byteLength, "and the one inside the window keeps its audio");
  assert.equal(tab.state.retentionSwept, 1);
  assert.ok(tab.warnings.some((line) => line.includes("older than the 30-day retention window")));
});

test("D6 — the sweep deletes the AUDIO too, not just the record", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  await ageCapture(origin, "mtg-old", 400);
  assert.ok((await origin.record("mtg-old"))?.byteLength, "the fixture wrote real bytes");
  await tab.surface.refreshRecoverable();
  assert.equal(await origin.record("mtg-old"), undefined);
  const store = new MeetingCaptureStore(origin.backend);
  const audio = await store.readAudio("mtg-old");
  assert.equal(audio.byteLength, 0, "D6 asks for a real deletion — the chunks go with the manifest");
});

test("D6 — the window the person sets is the window the sweep uses, and it takes effect at once", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  await ageCapture(origin, "mtg-ten-days", 10);
  await tab.surface.refreshRecoverable();
  assert.equal((await origin.records()).length, 1, "ten days is inside the default window");

  await tab.surface.setRetentionDays(7);
  assert.equal(tab.state.retentionDays, 7);
  assert.deepEqual((await origin.records()).map((record) => record.sessionId), [MEETING_RETENTION_CAPTURE_ID]);
  // …and it is remembered, so the next page load sweeps by the same number.
  assert.equal(await readCaptureRetentionDays(new MeetingCaptureStore(origin.backend)), 7);
});

test("D6 — a window out of range is clamped, and the surface shows the one in force", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  await tab.surface.setRetentionDays(5_000);
  assert.equal(tab.state.retentionDays, 365);
  await tab.surface.setRetentionDays(0);
  assert.equal(tab.state.retentionDays, 1);
});

test("D6 — the sweep never touches a capture another tab is recording into, however old it is", async () => {
  const origin = new CaptureOrigin();
  const writer = origin.tab();
  const watcher = origin.tab();
  await writer.surface.init();
  await writer.record();
  await chunk(writer);
  const live = writer.state.session?.id;
  assert.ok(live);
  // The live capture is aged past every window by rewriting its record's stamps
  // — the only way to reach "an old recording that is still being written".
  const store = new MeetingCaptureStore(origin.backend);
  const held = await store.read(live);
  assert.ok(held);
  const ancient = new Date(origin.clock - 400 * DAY_MS).toISOString();
  await store.setPayload(live, held.payload.replace(/"startedAt":"[^"]+"/g, `"startedAt":"${ancient}"`));

  await watcher.surface.setRetentionDays(1);
  await watcher.surface.refreshRecoverable();
  assert.ok(await origin.record(live), "a recording in progress is not a recording that has expired");
  // And the writer is still writing to it.
  await chunk(writer);
  assert.equal(writer.state.warning, "");
});

test("D6 — a browser that cannot see its other tabs deletes nothing on a schedule", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab({ withoutLocks: true });
  await tab.surface.init();
  await ageCapture(origin, "mtg-old", 400);
  await tab.surface.refreshRecoverable();
  assert.ok(await origin.record("mtg-old"), "D6a — where liveness cannot be answered, an unattended pass does not guess");
  assert.equal(tab.state.retentionSwept, 0);
});

test("D6 — the sweep leaves the compose draft and the window's own record alone", async () => {
  const origin = new CaptureOrigin();
  // Both reserved records, seeded WITH AN OLD STAMP: they are chunk-less
  // manifests that are never closed, so by age alone they are the first things
  // an unattended pass would delete — one holds what somebody typed, the other
  // holds the policy that decides when their audio goes.
  const store = new MeetingCaptureStore(origin.backend);
  const ancient = new Date(origin.clock - 400 * DAY_MS).toISOString();
  await store.begin({
    sessionId: MEETING_DRAFT_CAPTURE_ID,
    startedAt: ancient,
    payload: JSON.stringify({ title: "still writing this", transcript: "", language: "", template: "" }),
  });
  await store.begin({ sessionId: MEETING_RETENTION_CAPTURE_ID, startedAt: ancient, payload: JSON.stringify({ version: 1, days: 1 }) });

  const tab = origin.tab();
  await tab.surface.init();
  assert.equal(tab.state.retentionDays, 1, "the stored window is read back");
  assert.equal(tab.state.title, "still writing this", "and so is the draft");
  await tab.surface.refreshRecoverable();
  const ids = (await origin.records()).map((record) => record.sessionId).sort();
  assert.deepEqual(ids, [MEETING_DRAFT_CAPTURE_ID, MEETING_RETENTION_CAPTURE_ID].sort());
  assert.equal(await readCaptureRetentionDays(new MeetingCaptureStore(origin.backend)), 1);
});

test("D11 — the transcript reaches the server while the meeting is being recorded", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  tab.surface.setTitle("Weekly sync");
  await tab.record();
  // Enough chunks for the first unit to seal and settle — and no Stop, because
  // the claim is that the words leave the machine DURING the meeting.
  for (let index = 0; index < 8; index += 1) await chunk(tab);
  await flush();
  assert.equal(tab.state.recording, true);
  const pushed = origin.escrow.puts.at(-1);
  assert.ok(pushed, "a settled segment is pushed to the server, not held until Stop");
  assert.equal(pushed.record.title, "Weekly sync");
  assert.match(pushed.record.transcript, /spoken words/);
  assert.equal(pushed.orgId, "org-a", "the workspace frozen at Record, not the switcher's current one");
  assert.match(tab.state.durability, /also held on the server/);
});

test("D11 — a server that will not take it says so, rather than showing the same face", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab({ persistenceRefused: true });
  await tab.surface.init();
  origin.escrow.fails = new Error("gateway down");
  await tab.record();
  for (let index = 0; index < 8; index += 1) await chunk(tab);
  await flush();
  assert.match(tab.state.durability, /NOT granted persistent storage/);
  assert.match(tab.state.durability, /not holding a copy/);
  // And the recording is unaffected — D7: a meeting never fails because a server was down.
  assert.equal(tab.state.recording, true);
  assert.equal(tab.state.warning, "");
});

test("D11/D6 — filing or discarding a capture deletes the server's copy with it", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  tab.surface.setTitle("Filed");
  const created = await recordOne(tab);
  assert.ok(origin.escrow.rows.has(created), "the server was holding it while it was unfinished");
  await tab.surface.submit();
  assert.equal(origin.escrow.rows.has(created), false, "a created meeting is not an unfinished recording");

  tab.surface.setTitle("Thrown away");
  const discarded = await recordOne(tab);
  assert.ok(origin.escrow.rows.has(discarded));
  tab.confirmAnswer = true;
  await tab.surface.discardHeld();
  assert.equal(origin.escrow.rows.has(discarded), false, "D6 — deletion is a real deletion, including the copy the person cannot see");
});

test("D11 — a capture still on this device is offered from the device, not twice", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab();
  await first.surface.init();
  const sessionId = await recordOne(first);
  assert.ok(origin.escrow.rows.has(sessionId), "the server has a copy");
  // The tab dies without filing it, so the audio is still on the device and the
  // browser has released the lock — the ordinary §6 recovery case.
  first.kill();

  const reopened = origin.tab();
  await reopened.surface.init();
  await reopened.surface.refreshRecoverable();
  assert.deepEqual(reopened.state.recoverable.map((entry) => entry.record.sessionId), [sessionId], "offered from the device, which has the audio behind it");
  assert.deepEqual(reopened.state.escrowed, [], "and not a second time from the server");
});

test("§6 — persistence refused, then the origin evicted: the meeting is still recoverable", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab({ persistenceRefused: true });
  await tab.surface.init();
  tab.surface.setTitle("The long one");
  await tab.record();
  for (let index = 0; index < 6; index += 1) await chunk(tab);
  await tab.stop();
  const sessionId = tab.state.session?.id ?? tab.state.recoverable[0]?.record.sessionId;
  assert.ok(sessionId);
  assert.match(tab.state.durability, /can be evicted/, "the promise is named while it is still true");

  // The eviction. Not a kill: the tab is fine, the ORIGIN's storage is gone —
  // which is what `persist()` returning false permits a browser to do at any
  // moment, and what no amount of quota-watching prevents.
  tab.kill();
  const store = new MeetingCaptureStore(origin.backend);
  for (const record of await store.list()) await store.delete(record.sessionId);
  assert.deepEqual(await origin.records(), [], "the browser's copy is gone, audio and all");

  // A fresh tab over the emptied origin — the person reopening the page.
  const reopened = origin.tab({ persistenceRefused: true });
  await reopened.surface.init();
  await reopened.surface.refreshRecoverable();
  assert.deepEqual(reopened.state.recoverable, [], "there is nothing left on the device to offer");
  const offered = reopened.state.escrowed;
  assert.equal(offered.length, 1, "the server is the system of record, so the meeting is still there");
  assert.equal(offered[0]!.capture.sessionId, sessionId);
  assert.match(offered[0]!.capture.transcript, /spoken words/);

  // And it becomes a real meeting, which is what "recoverable" has to mean.
  await reopened.surface.restoreEscrowed(offered[0]!);
  assert.equal(reopened.state.title, "The long one");
  await reopened.surface.submit();
  assert.equal(reopened.posts.length, 1);
  assert.match(reopened.posts[0]!.transcript, /spoken words/);
  assert.equal(origin.escrow.rows.has(sessionId), false, "and the escrow is released once the meeting exists");
});

test("D11 — a transcript already in the box is not offered back a second time", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab();
  await first.surface.init();
  await recordOne(first);
  const store = new MeetingCaptureStore(origin.backend);
  for (const record of await store.list()) await store.delete(record.sessionId);
  first.kill();

  const reopened = origin.tab();
  await reopened.surface.init();
  await reopened.surface.refreshRecoverable();
  const offered = reopened.state.escrowed[0];
  assert.ok(offered);
  await reopened.surface.restoreEscrowed(offered);
  // The refresh that follows any other action must not put a Restore button
  // beside the transcript the person is looking at.
  await reopened.surface.refreshRecoverable();
  assert.deepEqual(reopened.state.escrowed, []);
  assert.match(reopened.state.transcript, /spoken words/);
});

test("D11 — a restored transcript can be thrown away, and that deletes the last copy", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab();
  await first.surface.init();
  const sessionId = await recordOne(first);
  const store = new MeetingCaptureStore(origin.backend);
  for (const record of await store.list()) await store.delete(record.sessionId);
  first.kill();

  const reopened = origin.tab();
  await reopened.surface.init();
  await reopened.surface.refreshRecoverable();
  const offered = reopened.state.escrowed[0];
  assert.ok(offered, `the server still holds ${sessionId}`);
  reopened.confirmAnswer = true;
  await reopened.surface.discardEscrowed(offered);
  assert.equal(origin.escrow.rows.size, 0);
  assert.deepEqual(reopened.state.escrowed, []);
  // The question names what is at stake: this row is the only copy left.
  assert.ok(reopened.confirms.some((question) => question.includes("only copy left")));
});

/**
 * ADR-035 D1/D2 — the renderer's half of the capture contract.
 *
 * Two things are worth asserting here and nothing else is: that a build whose
 * preload has no capture channels says so instead of pretending (ADR-028), and
 * that the scope a capture is started under is the one that crosses the bridge —
 * open question 5 is only answered if the org actually travels with the session.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createMeetingCaptureOps, MeetingCaptureUnavailableError } from "./captureOps.js";

function setBridge(meetings?: Record<string, (...args: never[]) => Promise<unknown>>): void {
  (globalThis as unknown as { brainrouter?: unknown }).brainrouter = meetings ? { meetings } : undefined;
}

const SESSION = { id: "mtg-1", startedAt: "2026-01-01T00:00:00.000Z", scope: { orgId: "org_1", workspaceId: null }, title: "Sync", template: "general", status: "recording", segments: [] };

test("a build without capture channels refuses to record instead of buffering in memory", async () => {
  setBridge({ list: async () => ({ meetings: [] }) });
  const capture = createMeetingCaptureOps();

  assert.equal(capture.available, false);
  await assert.rejects(() => capture.begin({ scope: { orgId: null } }), MeetingCaptureUnavailableError);
  await assert.rejects(() => capture.append("mtg-1", new Uint8Array([1]), 20_000), MeetingCaptureUnavailableError);
  // Nothing was ever captured by such a build, so the recovery offer is empty
  // rather than an error the user cannot act on.
  assert.deepEqual(await capture.resumable({ orgId: null }), []);
});

test("the capture scope and the recorder's content type travel with the session", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  setBridge({
    captureBegin: async (...args: never[]) => { calls.push({ method: "captureBegin", args }); return SESSION; },
    captureAppend: async (...args: never[]) => { calls.push({ method: "captureAppend", args }); return SESSION; },
    captureRead: async (...args: never[]) => { calls.push({ method: "captureRead", args }); return { bytes: new Uint8Array([1, 2]), contentType: "audio/webm;codecs=opus" }; },
    captureResumable: async (...args: never[]) => { calls.push({ method: "captureResumable", args }); return [{ sessionId: "mtg-1" }]; },
  });
  const capture = createMeetingCaptureOps();

  assert.equal(capture.available, true);
  assert.equal((await capture.begin({ scope: { orgId: "org_1" }, title: "Sync", contentType: "audio/webm;codecs=opus" })).id, "mtg-1");
  await capture.append("mtg-1", new Uint8Array([1]), 20_000);
  assert.equal((await capture.read("mtg-1")).contentType, "audio/webm;codecs=opus");
  assert.equal((await capture.resumable({ orgId: "org_1" })).length, 1);

  // D6 — `holderId` is on every call that takes or releases a recording, and it
  // is the SAME id each time: it identifies this BrowserWindow to a record a
  // second window reads, so an adapter that minted one per call would make every
  // window a stranger to its own capture.
  assert.deepEqual(calls, [
    { method: "captureBegin", args: [{ title: "Sync", contentType: "audio/webm;codecs=opus", orgId: "org_1", workspaceId: null, holderId: capture.holderId }] },
    { method: "captureAppend", args: ["mtg-1", new Uint8Array([1]), 20_000] },
    { method: "captureRead", args: ["mtg-1"] },
    { method: "captureResumable", args: [{ orgId: "org_1", workspaceId: null }] },
  ]);
  assert.match(capture.holderId, /^wr-/);
  assert.equal(createMeetingCaptureOps().holderId, capture.holderId, "one holder id per window, not per adapter");
});

test("F1 — the capture in hand is left out of the recovery offer", async () => {
  setBridge({
    captureBegin: async () => SESSION,
    captureAppend: async () => SESSION,
    captureResumable: async () => [{ sessionId: "mtg-live" }, { sessionId: "mtg-left-over" }],
  });
  const capture = createMeetingCaptureOps();

  // The store cannot answer this and should not try: D2's predicate is "audio
  // present, no terminal state", which the recording being made RIGHT NOW
  // satisfies — so the library offered to transcribe or DELETE it while the
  // microphone was still open. Only the window holding the recorder knows which
  // session that is.
  assert.deepEqual(
    (await capture.resumable({ orgId: null }, { exclude: ["mtg-live"] })).map((row) => row.sessionId),
    ["mtg-left-over"],
  );
  // …and with nothing in hand, nothing is dropped: every unfinished recording on
  // the device is still this ADR's deliverable.
  assert.deepEqual(
    (await capture.resumable({ orgId: null })).map((row) => row.sessionId),
    ["mtg-live", "mtg-left-over"],
  );
});

test("D6 — the compose draft crosses the bridge, and a stale record is narrowed rather than trusted", async () => {
  const calls: string[] = [];
  setBridge({
    captureBegin: async () => SESSION,
    captureAppend: async () => SESSION,
    draftRead: async () => { calls.push("draftRead"); return { title: "Sync", transcript: "Typed.", template: "standup", language: " en ", pastedBy: "ignored" }; },
    draftWrite: async () => { calls.push("draftWrite"); return { ok: true }; },
    draftClear: async () => { calls.push("draftClear"); return { ok: true }; },
  });
  const capture = createMeetingCaptureOps();

  assert.deepEqual(await capture.readDraft(), { title: "Sync", transcript: "Typed.", template: "standup", language: "en" });
  await capture.writeDraft({ title: "Sync", transcript: "Typed." });
  await capture.clearDraft();
  assert.deepEqual(calls, ["draftRead", "draftWrite", "draftClear"]);

  // The draft file outlives app versions and is rendered straight into the
  // compose form, so a record written by some other one is refused rather than
  // put on screen.
  setBridge({ captureBegin: async () => SESSION, captureAppend: async () => SESSION, draftRead: async () => ({ title: 7, transcript: null, template: "invented" }) });
  assert.equal(await createMeetingCaptureOps().readDraft(), null);
});

test("D6 — a preload with no draft channels keeps no draft, rather than keeping one where it must not", async () => {
  setBridge({ list: async () => ({ meetings: [] }) });
  const capture = createMeetingCaptureOps();

  assert.equal(capture.available, false);
  assert.equal(await capture.readDraft(), null);
  // Unlike `begin`/`append`, these resolve: a draft that does not persist costs
  // a retype, while the `localStorage` fallback that would persist it is the
  // exact store D6 moved the draft out of.
  await capture.writeDraft({ title: "Sync", transcript: "Typed." });
  await capture.clearDraft();
  // …but a caller that is about to DELETE the only other copy has to be able to
  // tell that write apart from one that landed. The migration out of
  // `localStorage` is that caller, and this is the flag it reads.
  assert.equal(capture.draftAvailable, false);
  // The case that actually cost a draft: a preload old enough to have the
  // CAPTURE channels but not the draft ones. `writeDraft` resolves there and
  // writes nothing, so the migration must be told before it deletes the
  // original.
  setBridge({ captureBegin: async () => SESSION, captureAppend: async () => SESSION });
  assert.equal(createMeetingCaptureOps().draftAvailable, false);
  setBridge({ captureBegin: async () => SESSION, captureAppend: async () => SESSION, draftWrite: async () => ({ ok: true }) });
  assert.equal(createMeetingCaptureOps().draftAvailable, true);
});

test("§6 — the segments the store could not read back cross the bridge with the audio", async () => {
  setBridge({
    captureBegin: async () => SESSION,
    captureAppend: async () => SESSION,
    captureRead: async () => ({ bytes: new Uint8Array([1, 2]), contentType: "audio/webm", missing: [1, "nonsense", 4.5, 3] }),
  });

  // Rendered as a count under the player, so a non-integer that got this far
  // would reach the user as part of a sentence about their recording.
  assert.deepEqual((await createMeetingCaptureOps().read("mtg-1")).missing, [1, 3]);

  // A host that predates the guard says nothing, which reads as "nothing was
  // missing" — the same answer it used to give by rejecting the whole read.
  setBridge({
    captureBegin: async () => SESSION,
    captureAppend: async () => SESSION,
    captureRead: async () => ({ bytes: new Uint8Array([1, 2]), contentType: "audio/webm" }),
  });
  assert.deepEqual((await createMeetingCaptureOps().read("mtg-1")).missing, []);
});

test("D6 — a writer row is only believed when all three of its fields are there", async () => {
  setBridge({
    captureBegin: async () => SESSION,
    captureAppend: async () => SESSION,
    captureWriting: async () => [
      { sessionId: "mtg-live", holderId: "wr-second-window", note: "Another window is recording this meeting right now." },
      // Every one of these is a row that would silently unlock a destructive
      // control over a live recording: a row with no holder id compares unequal
      // to THIS window's, so it would lock the capture this window is recording
      // and wedge its own Create; a row with no note renders an empty banner
      // where the explanation should be; a row with no session id locks nothing
      // at all while claiming something is live.
      { sessionId: "mtg-holderless", note: "Another window is recording this meeting right now." },
      { sessionId: "mtg-noteless", holderId: "wr-third-window" },
      { holderId: "wr-fourth-window", note: "Another window is recording this meeting right now." },
      null,
    ],
  });

  assert.deepEqual((await createMeetingCaptureOps().writing({ orgId: null })).map((row) => row.sessionId), ["mtg-live"]);

  // A preload that predates the channel answers nothing, which reads as "no
  // window is recording" — the answer this surface gave before D6 existed,
  // rather than an error over a feature it cannot take part in.
  setBridge({ captureBegin: async () => SESSION, captureAppend: async () => SESSION });
  assert.deepEqual(await createMeetingCaptureOps().writing({ orgId: null }), []);
});

test("a capture store that answers with the wrong shape is an error, not a silent no-op", async () => {
  setBridge({ captureBegin: async () => ({ id: "mtg-1" }), captureAppend: async () => ({ id: "mtg-1", segments: [] }), captureRead: async () => ({}) });
  const capture = createMeetingCaptureOps();

  await assert.rejects(() => capture.begin({ scope: { orgId: null } }), /invalid meeting session/);
  await assert.rejects(() => capture.read("mtg-1"), /returned no audio/);
});

/**
 * ADR-035 — the dashboard capture surface, driven rather than read.
 *
 * The sibling `meetingCaptureContract.test.ts` asserts over SOURCE TEXT, and it
 * has been the only instrument this page had. It cannot tell you what a value
 * was: the doubled transcript, the unmarked hole and the org that could be
 * respelled all typechecked and all kept every source assertion true. So this
 * file presses the buttons — Record, a chunk, Stop, leave the page, Create — and
 * asserts what reached the POST, what is on the device afterwards, and what a
 * SECOND TAB over the same origin is allowed to do to it.
 *
 * Every test here is written so that deleting or inverting the production line
 * it protects makes it fail. Where that is not obvious the comment says which
 * line, in the defect's own words.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isCaptureBeingWritten, MEETING_CAPTURE_LEASE_STALE_MS } from "@kinqs/brainrouter-core/meetings";

import { isCapturePayloadBeingWritten, resumableCaptures } from "../../lib/meetings/capturePayload";
import { CaptureOrigin, flush } from "./_captureSurfaceHarness";

/** Record, one chunk, Stop — the shortest complete meeting. */
async function recordOneChunk(tab: Awaited<ReturnType<CaptureOrigin["tab"]>>): Promise<string> {
  await tab.record();
  await tab.chunk();
  const sessionId = tab.state.session?.id;
  assert.ok(sessionId, "a session exists from the moment Record is pressed");
  return sessionId;
}

test("D2 — Record writes a session, its writer and its audio, in that order", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  tab.surface.setTitle("Weekly sync");
  const sessionId = await recordOneChunk(tab);

  const record = await origin.record(sessionId);
  assert.ok(record, "the manifest exists");
  assert.equal(record.chunks.length, 1, "the chunk is on the device");
  const stored = await origin.session(sessionId, "org-a");
  assert.equal(stored.segments.length, 1, "and the session claims it");
  assert.equal(stored.segments[0].byteLength, 1024, "with what the store actually took");
  // D6/the lease — the manifest names its writer BEFORE any audio exists, which
  // is what makes a tab killed during the microphone prompt distinguishable
  // from one still waiting for it.
  assert.equal(stored.writer?.holderId, tab.holderId);
  assert.equal(stored.writer?.epoch, 1);
  const beganBeforeAudio = origin.backend.calls.indexOf(`wroteManifest:${sessionId}`);
  const firstChunk = origin.backend.calls.indexOf(`writeChunk:${sessionId}:0`);
  assert.ok(beganBeforeAudio >= 0 && beganBeforeAudio < firstChunk, "the session exists before the audio does");
});

test("A — leaving the page stops the recording, releases the microphone and lands the meeting", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  const sessionId = await recordOneChunk(tab);
  assert.equal(tab.state.recording, true);

  // The client-side navigation. Without the unmount teardown this returns with
  // the recorder still running and the microphone still open — and nothing is
  // flushed afterwards on purpose: what `dispose()` resolves with is the whole
  // guarantee, because a page that has navigated away has nobody left to wait.
  await tab.surface.dispose();

  // Asserted FIRST and with nothing awaited in between: `dispose()` resolving
  // while the capture is still settling is the same promise nobody is left to
  // wait on, which is the whole of what a navigation takes away.
  assert.equal(tab.state.settling, false, "the settle finished before dispose resolved");
  assert.equal(tab.recorder.stops, 1, "the recorder is stopped");
  assert.equal(tab.recorder.state, "inactive");
  assert.ok(tab.microphone.releases >= 1, "and the microphone is released");
  assert.equal(tab.state.recording, false);
  const stored = await origin.session(sessionId, "org-a");
  assert.equal(stored.status, "stopped", "the recording is settled rather than left mid-flight");
  assert.equal(stored.segments.length, 1, "with the audio it had");
});

test("A — a live recording is not offered back to a second tab, and cannot be deleted by one", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab({ holderId: "wr-first" });
  await first.surface.init();
  const sessionId = await recordOneChunk(first);

  // The SAME origin, a different tab — a second browser tab, or this page
  // remounted after a navigation that did not tear down. Its guards are empty by
  // construction, which is the whole reason liveness lives in the record.
  const second = origin.tab({ holderId: "wr-second" });
  await second.surface.init();
  await second.surface.refreshRecoverable();
  assert.deepEqual(second.state.recoverable.map((entry) => entry.record.sessionId), [], "nothing is offered while it is being recorded");

  const record = await origin.record(sessionId);
  assert.ok(record);
  await second.surface.discard(record);
  await flush();
  assert.match(second.state.createError, /cannot be deleted/i);
  assert.ok(await origin.record(sessionId), "the recording is still on the device");
  const stored = await origin.session(sessionId, "org-a");
  assert.equal(stored.segments.length, 1, "with its audio intact");
});

test("A — and a second tab cannot pick the live recording up either", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab({ holderId: "wr-first" });
  await first.surface.init();
  const sessionId = await recordOneChunk(first);
  const record = await origin.record(sessionId);
  assert.ok(record);
  const session = await origin.session(sessionId, "org-a");

  const second = origin.tab({ holderId: "wr-second" });
  await second.surface.init();
  await second.surface.pickUp({ record, session });
  await flush();
  assert.match(second.state.createError, /recording this meeting right now/i);
  // …and the first tab still holds it: two queues over one session would
  // interleave their writes and one set of segments would be lost.
  const after = await origin.session(sessionId, "org-a");
  assert.equal(after.writer?.holderId, "wr-first");
  assert.equal(after.writer?.epoch, 1, "the epoch did not move, so nothing was fenced out");
});

test("the lease is renewed by the CHUNK, not only by a timer that a background tab loses", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  const sessionId = await recordOneChunk(tab);
  const first = (await origin.session(sessionId, "org-a")).writer?.heartbeatAt;

  // A backgrounded tab: the clock moves past the staleness window and no timer
  // fires, because timers there are clamped. The only heartbeat left is the one
  // riding `ondataavailable`.
  origin.skip(MEETING_CAPTURE_LEASE_STALE_MS + 5_000);
  await tab.chunk();

  const renewed = await origin.session(sessionId, "org-a");
  assert.notEqual(renewed.writer?.heartbeatAt, first, "the stamp moved");
  assert.equal(renewed.writer?.holderId, tab.holderId, "and it is still this tab's recording");
  // The term had lapsed while the tab was throttled, so the shared rule refuses
  // to RENEW it — reviving an expired lease is the one thing invariant 4 forbids
  // — and the surface acquires it again instead, which is what the new epoch is.
  assert.equal(renewed.writer?.epoch, 2);
  assert.equal(isCaptureBeingWritten(renewed, new Date(origin.clock).toISOString()), true);
});

test("a crashed tab's recording is offered back once its lease lapses, and can then be discarded", async () => {
  const origin = new CaptureOrigin();
  const killed = origin.tab({ holderId: "wr-killed" });
  await killed.surface.init();
  const sessionId = await recordOneChunk(killed);
  // A kill: no Stop, no teardown, no heartbeat. Only expiry can be trusted.
  origin.skip(MEETING_CAPTURE_LEASE_STALE_MS + 1_000);

  const reopened = origin.tab({ holderId: "wr-reopened" });
  await reopened.surface.init();
  await reopened.surface.refreshRecoverable();
  assert.deepEqual(reopened.state.recoverable.map((entry) => entry.record.sessionId), [sessionId]);

  const record = await origin.record(sessionId);
  assert.ok(record);
  await reopened.surface.discard(record);
  await flush();
  assert.equal(reopened.state.createError, "", "no refusal — nobody is writing to it");
  assert.equal(await origin.record(sessionId), undefined, "and the audio is really gone");
});

test("Stop hands the recording back at once rather than after the staleness window", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  const sessionId = await recordOneChunk(tab);
  await tab.stop();

  const stored = await origin.session(sessionId, "org-a");
  assert.equal(stored.status, "stopped");
  assert.equal(
    isCaptureBeingWritten(stored, new Date(origin.clock).toISOString()),
    false,
    "the lease is released, not left to lapse",
  );
  // The offer is the shared rule's, asked over the record as it now stands.
  const offered = resumableCaptures(await origin.records(), { scope: { orgId: "org-a" }, at: new Date(origin.clock).toISOString() });
  assert.deepEqual(offered.map((entry) => entry.record.sessionId), [sessionId]);
});

test("a writer that lost its lease stops recording and says so", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab({ holderId: "wr-first" });
  await first.surface.init();
  const sessionId = await recordOneChunk(first);

  // The first tab froze for longer than the window; a second tab took the
  // recording over, which bumps the epoch and fences the first one out.
  origin.skip(MEETING_CAPTURE_LEASE_STALE_MS + 1_000);
  const second = origin.tab({ holderId: "wr-second" });
  await second.surface.init();
  await second.surface.refreshRecoverable();
  const entry = second.state.recoverable[0];
  assert.ok(entry, "the lapsed recording is offered to the second tab");
  await second.surface.pickUp(entry);
  await flush();
  assert.equal((await origin.session(sessionId, "org-a")).writer?.holderId, "wr-second");

  // …and now the first tab wakes up and tries to write more audio.
  await first.chunk();
  assert.equal(first.state.recording, false, "it stops recording rather than writing over the other tab");
  assert.match(first.state.warning, /no longer being written by this tab/i);
  assert.equal((await origin.session(sessionId, "org-a")).writer?.holderId, "wr-second", "and it did not take the lease back");
  assert.equal((await origin.record(sessionId))?.chunks.length, 1, "nor did it append its microphone's audio to the other tab's meeting");
});

test("a tab that RELOADS reclaims its own lease immediately", async () => {
  const origin = new CaptureOrigin();
  const before = origin.tab({ holderId: "wr-same-tab" });
  await before.surface.init();
  const sessionId = await recordOneChunk(before);

  // A reload: the page is new, the recorder is gone, and `sessionStorage` hands
  // the same holder id back. Waiting the window out here would mean a tab could
  // not resume the recording it was making a second ago.
  const after = origin.tab({ holderId: "wr-same-tab" });
  await after.surface.init();
  const record = await origin.record(sessionId);
  assert.ok(record);
  await after.surface.pickUp({ record, session: await origin.session(sessionId, "org-a") });
  await flush();
  assert.equal(after.state.createError, "");
  const stored = await origin.session(sessionId, "org-a");
  assert.equal(stored.writer?.holderId, "wr-same-tab");
  assert.equal(stored.writer?.epoch, 2, "a re-acquisition always mints a new epoch, even for the same holder");
});

test("B — the POST carries the workspace frozen at Record, not the one the switcher moved to", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab({ orgId: "org-recorded-in" });
  await tab.surface.init();
  tab.surface.setTitle("Board review");
  await recordOneChunk(tab);
  await tab.stop();

  // ADR-019's switcher moves while the meeting is unfinished. Sending the
  // CURRENT org would land an hour of somebody's audio in whichever workspace
  // happened to be selected when they pressed Create.
  tab.orgId = "org-switched-to";
  await tab.surface.submit();
  await flush();

  assert.equal(tab.posts.length, 1);
  assert.equal(tab.posts[0].orgId, "org-recorded-in");
  assert.equal(tab.posts[0].title, "Board review");
  assert.ok(tab.posts[0].transcript.includes("spoken words"), "and the transcribed audio went with it");
});

test("B — a pasted transcript with no capture behind it uses the active workspace", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab({ orgId: "org-current" });
  await tab.surface.init();
  tab.surface.setTitle("Pasted notes");
  tab.surface.setTranscript("we talked about the roadmap");
  await tab.surface.submit();
  await flush();

  assert.equal(tab.posts.length, 1);
  assert.equal(tab.posts[0].orgId, "org-current");
  assert.equal(tab.posts[0].transcript, "we talked about the roadmap");
});

test("D5 — a segment that never transcribed is POSTed as a stated gap, and the audio is only released after the meeting exists", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  tab.surface.setTitle("Outage");
  tab.surface.setTranscript("agenda: the outage");
  tab.transcribeSegment = async () => {
    throw new Error("the sidecar is a black hole");
  };
  const sessionId = await recordOneChunk(tab);
  await tab.stop();
  await origin.advance(60_000);

  await tab.surface.submit();
  await flush();
  assert.equal(tab.posts.length, 1);
  assert.match(tab.posts[0].transcript, /could not be transcribed/, "the hole is stated rather than omitted");
  assert.match(tab.posts[0].transcript, /^agenda: the outage/, "and the person's own words keep their place above it");
  assert.equal(await origin.record(sessionId), undefined, "the audio is released once the meeting exists on the server");
});

test("a create that FAILS keeps the recording on the device to be offered back", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  tab.surface.setTitle("Doomed");
  const sessionId = await recordOneChunk(tab);
  await tab.stop();
  tab.postFails = new Error("the server said no");

  await tab.surface.submit();
  await flush();
  assert.match(tab.state.createError, /the server said no/);
  const record = await origin.record(sessionId);
  assert.ok(record, "the audio is still here");
  assert.equal(record.closed, false, "and the meeting was not marked settled");

  // …and trying again does not post the meeting twice over. The settle moved the
  // fold forward, so a second attempt re-states nothing: a fold left behind the
  // box appends the gap markers it just wrote a second time.
  tab.postFails = null;
  await tab.surface.submit();
  await flush();
  assert.equal(tab.posts.length, 2);
  assert.equal(tab.posts[1].transcript, tab.posts[0].transcript, "the same transcript, not a doubled one");
});

test("a recording waiting on the microphone prompt keeps saying it is alive", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  await tab.record();
  const sessionId = tab.state.session?.id ?? "";

  // No chunk has landed and none will for as long as the prompt is on screen, so
  // the only heartbeat is the timer's. Without it every other tab reads this
  // recording as abandoned before the microphone is even granted.
  await origin.advance(MEETING_CAPTURE_LEASE_STALE_MS + 5_000);
  const stored = await origin.session(sessionId, "org-a");
  assert.equal(isCaptureBeingWritten(stored, new Date(origin.clock).toISOString()), true);
});

test("a picked-up capture can be created from the tab that picked it up", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab({ holderId: "wr-first" });
  await first.surface.init();
  const sessionId = await recordOneChunk(first);
  await first.surface.dispose();
  await flush();

  const second = origin.tab({ holderId: "wr-second" });
  await second.surface.init();
  second.surface.setTitle("Picked up");
  await second.surface.refreshRecoverable();
  const entry = second.state.recoverable.find((candidate) => candidate.record.sessionId === sessionId);
  assert.ok(entry);
  await second.surface.pickUp(entry);
  await flush();
  // The tab now HOLDS the lease, so the close has to name itself as the actor or
  // the shared transition refuses to finalize a meeting somebody is writing.
  await second.surface.submit();
  await flush();
  assert.equal(second.posts.length, 1, second.state.createError);
  assert.equal(await origin.record(sessionId), undefined, "and the audio was released");
});

test("D — Create stops refusing as soon as the last chunk has landed, not when transcription finishes", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  tab.surface.setTitle("Long tail");
  tab.surface.setTranscript("agenda item one");
  // An endpoint that has taken the audio and not answered yet. Under D7 that can
  // last an outage of any length, and the guard used to be held across it: long
  // after the last chunk was safely on the device, Create still refused with
  // "the end of this recording is still being written to this device".
  const answer = tab.deferTranscription();
  await tab.record();
  const sessionId = tab.state.session?.id ?? "";
  // Delivered by `stop()`, exactly as a real MediaRecorder delivers its last
  // chunk — so this covers the settle racing `onstop` as well.
  tab.recorder.pending.push(new Blob([new Uint8Array(2048).fill(3)]));
  await tab.stop();

  assert.equal(tab.state.settling, false, "the settling window ended with the audio, not with the transcript");
  assert.equal(tab.state.recording, false);
  // …and it ended AFTER the last chunk, not before it: the meeting has its
  // ending, both as bytes and as a segment that claims them.
  assert.equal((await origin.record(sessionId))?.chunks.length, 1, "the final chunk is on the device");
  assert.equal(tab.state.session?.segments.length, 1, "and the meeting claims it");

  // Create goes through, and what it posts states the segment that has not come
  // back as a gap with its time range — left alone it would contribute nothing
  // and the sentences either side of it would read as contiguous speech.
  const submitted = tab.surface.submit();
  await flush();
  assert.equal(tab.posts.length, 1);
  assert.match(tab.posts[0].transcript, /^agenda item one/, "the person's own words keep their place");
  assert.match(tab.posts[0].transcript, /could not be transcribed/, "and the unresolved segment is stated");

  answer.resolve("late words");
  await submitted;
  await flush();
  assert.equal(await origin.record(sessionId), undefined, "the audio is released once the meeting exists");
});


test("Create refuses while the recording is still in flight, in the function and not only on the button", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  tab.surface.setTitle("Still going");
  tab.surface.setTranscript("something typed");
  await recordOneChunk(tab);

  await tab.surface.submit();
  await flush();
  assert.equal(tab.posts.length, 0, "nothing was posted");
  assert.match(tab.state.createError, /Stop the recording/i);
  const stored = await origin.session(tab.state.session?.id ?? "", "org-a");
  assert.notEqual(stored.status, "finalized", "and the capture was not finalized under the live recorder");
});

test("D4 — a recovered capture is folded into the restored box once, not appended a second time", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab({ holderId: "wr-first" });
  await first.surface.init();
  first.surface.setTitle("Standup");
  const sessionId = await recordOneChunk(first);
  await first.surface.dispose();
  await flush();
  const box = first.state.transcript;
  assert.match(box, /spoken words/, "the segment reached the compose box during the meeting");

  // The reload: the draft comes back holding this capture's settled segments
  // ALREADY, so a fold that starts at segment zero appends every one of them a
  // second time — and the doubled text is what gets POSTed and summarized.
  const reopened = origin.tab({ holderId: "wr-reopened" });
  await reopened.surface.init();
  reopened.surface.setTranscript(box);
  await reopened.surface.refreshRecoverable();
  const entry = reopened.state.recoverable.find((candidate) => candidate.record.sessionId === sessionId);
  assert.ok(entry, "the stopped capture is offered back");
  await reopened.surface.pickUp(entry);
  await flush();

  assert.equal(reopened.state.transcript, box, "the box is unchanged — nothing was appended twice");
  assert.equal(reopened.state.transcript.split("spoken words").length - 1, 1);
});

test("D4 — a note typed between two segments keeps its place across a kill", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  let spoken = 0;
  tab.transcribeSegment = async () => {
    spoken += 1;
    return `segment ${spoken}`;
  };
  await tab.record();
  await tab.chunk();
  await origin.advance(1_000);
  const withFirst = tab.state.transcript;
  assert.match(withFirst, /segment 1/);
  // The person types their own note under the first segment.
  tab.surface.setTranscript(`${withFirst}\nACTION: ship it`);
  await tab.chunk();
  await origin.advance(1_000);

  const lines = tab.state.transcript.split("\n").filter(Boolean);
  assert.equal(lines[lines.length - 2], "ACTION: ship it", "the note stays where it was put");
  assert.match(lines[lines.length - 1], /segment 2/, "and the new segment is appended after it");
});

test("C — a recording abandoned before its first chunk is reaped rather than left unreachable", async () => {
  const origin = new CaptureOrigin();
  const abandoned = origin.tab({ holderId: "wr-abandoned" });
  await abandoned.surface.init();
  // Killed during the microphone prompt: `begin` has run, no audio exists.
  abandoned.microphoneFails = true;
  await abandoned.surface.record();
  await flush();
  // `record()`'s own failure path deletes it, so drive the case that leaves it
  // behind: a manifest written and then nothing at all.
  await abandoned.store.begin({ sessionId: "mtg-orphan-metadata", startedAt: new Date(origin.clock).toISOString(), payload: "{}" });
  const before = await origin.records();
  assert.ok(before.some((record) => record.sessionId === "mtg-orphan-metadata"));

  const later = origin.tab({ holderId: "wr-later" });
  await later.surface.init();
  await later.surface.refreshRecoverable();

  const after = await origin.records();
  assert.equal(after.some((record) => record.sessionId === "mtg-orphan-metadata"), false, "it is gone");
  assert.deepEqual(later.state.recoverable, [], "and it was never offerable in the first place");
});

test("D6 — the manifest names its writer while the microphone prompt is still on screen", async () => {
  const origin = new CaptureOrigin();
  const waiting = origin.tab({ holderId: "wr-waiting" });
  await waiting.surface.init();
  // The prompt is up and the person has not answered it. Everything a second tab
  // can see about this recording is what `begin` wrote, so `begin` has to have
  // written the writer — otherwise the reap's only question about a chunk-less
  // manifest ("is somebody recording into this?") has nothing to read.
  waiting.microphonePending = true;
  void waiting.start();
  await flush();

  const records = await origin.records();
  assert.equal(records.length, 1, "the session exists before the microphone does");
  const at = new Date(origin.clock).toISOString();
  assert.equal(isCapturePayloadBeingWritten(records[0].payload, at), true);

  const other = origin.tab({ holderId: "wr-other" });
  await other.surface.init();
  await other.surface.refreshRecoverable();
  assert.equal((await origin.records()).length, 1, "and no other tab reclaims it");
});

test("C — the reap survives a recording another tab begins after the caller took its listing", async () => {
  const origin = new CaptureOrigin();
  const reaper = origin.tab({ holderId: "wr-reaper" });
  await reaper.surface.init();

  // The one window `keep` structurally cannot cover: the reaping tab took its
  // own listing, and only then does another tab press Record. OPFS is scoped to
  // the origin, so the new session is invisible to the caller's list and present
  // in the reap's — and it holds no audio yet, which is exactly the shape defect
  // C reclaims.
  const recorder = origin.tab({ holderId: "wr-recorder" });
  await recorder.surface.init();
  // On the SECOND listing, which is the reap's own — the caller's `list()` took
  // the first, and the whole point is that this session is absent from that one.
  let listings = 0;
  origin.backend.beforeListSessionIds = async () => {
    listings += 1;
    if (listings !== 2) return;
    recorder.microphonePending = true;
    void recorder.start();
    await flush();
  };

  await reaper.surface.refreshRecoverable();
  origin.backend.beforeListSessionIds = undefined;
  const survived = (await origin.records()).filter((record) => record.sessionId !== "brainrouter-meeting-draft");
  assert.equal(survived.length, 1, "the recording that started mid-reap is still there");
  assert.equal(isCapturePayloadBeingWritten(survived[0].payload, new Date(origin.clock).toISOString()), true);
});

test("C — but the reap leaves alone a recording another tab has only just begun", async () => {
  const origin = new CaptureOrigin();
  const recording = origin.tab({ holderId: "wr-recording" });
  await recording.surface.init();
  await recording.record();
  const sessionId = recording.state.session?.id;
  assert.ok(sessionId, "the session exists before any audio does");
  assert.equal((await origin.record(sessionId))?.chunks.length ?? 0, 0, "and holds no audio yet");

  const other = origin.tab({ holderId: "wr-other" });
  await other.surface.init();
  await other.surface.refreshRecoverable();

  assert.ok(await origin.record(sessionId), "the microphone prompt is not a reason to delete a meeting");
  await recording.chunk();
  assert.equal((await origin.session(sessionId, "org-a")).segments.length, 1);
});

test("a record this tab cannot read is not a reason to take the recording back", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab({ holderId: "wr-first" });
  await first.surface.init();
  const sessionId = await recordOneChunk(first);
  origin.skip(MEETING_CAPTURE_LEASE_STALE_MS + 1_000);

  const second = origin.tab({ holderId: "wr-second" });
  await second.surface.init();
  await second.surface.refreshRecoverable();
  const entry = second.state.recoverable[0];
  assert.ok(entry);
  await second.surface.pickUp(entry);
  await flush();
  assert.equal((await origin.session(sessionId, "org-a")).writer?.holderId, "wr-second");

  // Now the first tab's beat cannot read the record at all. Renewing on a
  // reading it does not have would hand the recording back to the writer the
  // fence was raised against — silently, and while the other tab is writing.
  origin.backend.failManifestReads.add(sessionId);
  await first.chunk();
  const after = await origin.session(sessionId, "org-a");
  assert.equal(after.writer?.holderId, "wr-second", "the lease is not taken back on a reading nobody has");
  assert.equal(after.writer?.epoch, 2, "and no epoch was minted over it");
  assert.equal(after.segments.length, 1, "nor was the other tab's session written over");
});

test("…but a store having a bad moment INSIDE the term does not cost the meeting a chunk", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  await recordOneChunk(tab);
  const sessionId = tab.state.session?.id ?? "";

  // Same unreadable record, but this tab's own term is still running — so
  // nobody can legitimately have taken the recording, and refusing to write
  // would be the loss this ADR exists to prevent arriving through the door meant
  // to stop it.
  origin.backend.failManifestReads.add(sessionId);
  await tab.chunk();
  assert.equal((await origin.record(sessionId))?.chunks.length, 2, "the audio is written");
  assert.equal(tab.state.session?.segments.length, 2, "and the meeting claims it");
});

test("D6 — the compose draft survives a navigation, debounce and all", async () => {
  const origin = new CaptureOrigin();
  const typing = origin.tab();
  await typing.surface.init();
  typing.surface.setTitle("Half a thought");
  typing.surface.setTranscript("only the beginning");
  // Away before the debounce fires. A draft that is only ever written by a timer
  // is a draft the last thing you typed is never in.
  await typing.surface.dispose();
  await flush();

  const reopened = origin.tab();
  await reopened.surface.init();
  assert.equal(reopened.state.title, "Half a thought");
  assert.equal(reopened.state.transcript, "only the beginning");
  assert.equal(reopened.state.draftRecovered, true);
});

test("D6 — the reap cannot take the compose draft, which is a manifest with no audio", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  tab.surface.setTitle("Half a thought");
  tab.surface.setTranscript("only the beginning");
  await origin.advance(1_000);
  await flush();

  // The reap runs BEFORE the draft is read back, which is the order that
  // matters: the draft's record is a manifest that holds no audio and is never
  // closed, and that is now exactly the shape defect C reclaims. The one thing
  // separating them is that this id is not a meeting at all.
  const reopened = origin.tab();
  await reopened.surface.refreshRecoverable();
  await reopened.surface.init();
  assert.equal(reopened.state.title, "Half a thought", "the draft survived the reap and the reload");
  assert.equal(reopened.state.transcript, "only the beginning");
  assert.equal(reopened.state.draftRecovered, true);
});

test("§6 — the audio that came back is playable, and its object URL is handed back on the way out", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab();
  await first.surface.init();
  const sessionId = await recordOneChunk(first);
  await first.surface.dispose();
  await flush();

  const reopened = origin.tab();
  await reopened.surface.init();
  await reopened.surface.refreshRecoverable();
  const record = (await origin.records()).find((candidate) => candidate.sessionId === sessionId);
  assert.ok(record);
  await reopened.surface.previewCapture(record);
  await flush();
  assert.equal(reopened.state.preview?.sessionId, sessionId);
  assert.equal(reopened.state.preview?.missing, 0, "every chunk read back");

  reopened.surface.closeDialog();
  assert.deepEqual(reopened.revokedUrls, reopened.objectUrls, "the URL over a whole meeting is not left pinned in the heap");
  assert.equal(reopened.state.preview, null);
});

test("a chunk the store refuses is reported as lost audio, and one it accepts is not", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  await tab.record();
  const sessionId = tab.state.session?.id ?? "";
  origin.backend.failWrites.add(`${sessionId}:0`);
  await tab.chunk();
  assert.match(tab.state.warning, /A piece of this recording could not be saved/);
  assert.equal((await origin.session(sessionId, "org-a")).segments.length, 0, "no segment claims audio that does not exist");

  // The next chunk fills the sequence the failed one left free, so the recording
  // continues with no hole in it.
  await tab.chunk();
  assert.equal((await origin.session(sessionId, "org-a")).segments.length, 1);
});

test("the microphone is released when the recorder will not start, and Create is not wedged", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  tab.microphoneFails = true;
  tab.surface.setTitle("No microphone");
  tab.surface.setTranscript("typed instead");
  await tab.record();

  assert.match(tab.state.createError, /Microphone access/);
  assert.equal(tab.state.recording, false);
  // The guard is released on the failure path too: leaked, it makes every later
  // submit refuse while `recording` is false and the button says "Record", so
  // there is nothing to stop and only a reload clears it.
  await tab.surface.submit();
  await flush();
  assert.equal(tab.posts.length, 1, "a pasted transcript can still be created");
});

test("the microphone is released when the RECORDER will not start", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  // The stream went inactive between `getUserMedia` and `start()` — a mic
  // unplugged, a Bluetooth headset dropping. `onstop` is what stops the tracks
  // and it never fires for a recorder that would not start, so without an
  // explicit release the microphone stays open with nothing recording it.
  tab.recorderStartFails = true;
  await tab.record();

  assert.equal(tab.microphone.releases, 1, "the microphone is handed back");
  assert.equal(tab.state.recording, false);
  assert.match(tab.state.createError, /Microphone access/);
  const left = (await origin.records()).filter((record) => record.sessionId !== "brainrouter-meeting-draft");
  assert.deepEqual(left, [], "and the session it created is cleaned up rather than left to be offered back");
});

test("D8 — the import path appends to the box and does not touch the capture", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  tab.surface.setTranscript("earlier notes");
  tab.importText = "  transcribed from a file  ";
  const kept = await tab.surface.importAudio(new Blob([new Uint8Array(64).fill(1)]));
  assert.equal(kept, true);
  assert.equal(tab.state.transcript, "earlier notes\ntranscribed from a file");
  assert.equal(tab.state.busy, "");

  assert.equal(await tab.surface.importAudio(new Blob([])), false, "an empty file is refused before it is uploaded");
  assert.match(tab.state.createError, /empty/);
});

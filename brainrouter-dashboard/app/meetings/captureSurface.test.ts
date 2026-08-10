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
 * **Almost nothing here moves the clock any more, and that is the point.** The
 * lease this replaced could only be exercised by stepping a fake clock past a
 * thirty-second threshold, and every question it answered ("is that tab still
 * there?") was answered late in one direction and wrongly in the other. A Web
 * Lock has no interval: `tab.kill()` drops what the tab held, in the same turn,
 * and every "is somebody writing to this?" below is asked with the clock exactly
 * where it started. The clock survives for the two things that really are about
 * elapsed time — the draft debounce and D7's outage backoff.
 *
 * Every test here is written so that deleting or inverting the production line
 * it protects makes it fail. Where that is not obvious the comment says which
 * line, in the defect's own words.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { captureLockName } from "../../lib/meetings/captureLock";
import { resumableCaptures } from "../../lib/meetings/capturePayload";
import { SegmentTranscriptionError } from "../../lib/meetings/captureQueue";
import { CaptureOrigin, flush } from "./_captureSurfaceHarness";

/** Record, one chunk, Stop — the shortest complete meeting. */
async function recordOneChunk(tab: Awaited<ReturnType<CaptureOrigin["tab"]>>): Promise<string> {
  await tab.record();
  await tab.chunk();
  const sessionId = tab.state.session?.id;
  assert.ok(sessionId, "a session exists from the moment Record is pressed");
  return sessionId;
}

/** Whether any tab of this origin is holding the lock over a capture. */
function locked(origin: CaptureOrigin, sessionId: string): boolean {
  return origin.locks.names.includes(captureLockName(sessionId));
}

test("D2 — Record takes the LOCK, then writes the session, then the audio, in that order", async () => {
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
  assert.equal(stored.writer, undefined, "no lease is written down — liveness is not a fact about bytes");

  // The order is the whole of defect C. The lock is what says "a tab is writing
  // to this", and it is taken before the record it is about exists — so there is
  // no instant, however short, in which the manifest is on the device and
  // nothing says who is recording into it. Moving the acquisition below `begin`
  // (or below `openMicrophone`, which is where the heartbeat effectively sat)
  // fails here.
  const held = origin.backend.calls.indexOf(`lockHeld:${captureLockName(sessionId)}`);
  const beganBeforeAudio = origin.backend.calls.indexOf(`wroteManifest:${sessionId}`);
  const firstChunk = origin.backend.calls.indexOf(`writeChunk:${sessionId}:0`);
  assert.ok(held >= 0, "the lock is taken");
  assert.ok(held < beganBeforeAudio, "before the session record exists");
  assert.ok(beganBeforeAudio < firstChunk, "which itself exists before the audio does");
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
  // …and the lock goes with it. A client-side navigation leaves the TAB alive,
  // so nothing else would ever hand it back and this meeting would stay out of
  // every offer — including this browser's own — until the tab was closed.
  assert.equal(locked(origin, sessionId), false);
});

test("A — a live recording is not offered back to a second tab, and cannot be deleted by one", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab();
  await first.surface.init();
  const sessionId = await recordOneChunk(first);

  // The SAME origin, a different tab — a second browser tab, or this page
  // remounted after a navigation that did not tear down. Its guards are empty by
  // construction, which is the whole reason liveness lives in the record.
  const second = origin.tab();
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
  const first = origin.tab();
  await first.surface.init();
  const sessionId = await recordOneChunk(first);
  const record = await origin.record(sessionId);
  assert.ok(record);
  const session = await origin.session(sessionId, "org-a");

  const second = origin.tab();
  await second.surface.init();
  await second.surface.pickUp({ record, session });
  await flush();
  assert.match(second.state.createError, /recording this meeting right now/i);
  // …and the first tab still holds it: two queues over one session would
  // interleave their writes and one set of segments would be lost. A refused
  // acquisition takes nothing and leaves nothing behind, so the first tab can
  // carry on without ever learning this happened.
  assert.equal(first.locks.holds(sessionId), true);
  assert.equal(second.locks.holds(sessionId), false);
  await first.chunk();
  assert.equal((await origin.session(sessionId, "org-a")).segments.length, 2, "and it is still recording");
});

test("a tab holding a recording cannot be robbed of it, however long it is frozen", async () => {
  const origin = new CaptureOrigin();
  const recording = origin.tab();
  await recording.surface.init();
  const sessionId = await recordOneChunk(recording);

  // A BACKGROUNDED tab: its timers are clamped and the wall clock runs away
  // from it. Under the lease this was the common failure — no heartbeat for
  // longer than the window, so a perfectly live recording read as abandoned and
  // a second tab was offered it. The browser holds a lock for a frozen tab, so
  // there is no such state to be in.
  origin.skip(10 * 60_000);

  const other = origin.tab();
  await other.surface.init();
  await other.surface.refreshRecoverable();
  assert.deepEqual(other.state.recoverable, [], "ten minutes of silence is not evidence of anything");
  assert.deepEqual(other.state.writing, [sessionId], "the surface knows a tab is writing to it");

  // …and the recording carries on when the tab wakes up, with no lease to
  // re-acquire and nothing to have lost.
  await recording.chunk();
  assert.equal(recording.state.recording, true);
  assert.equal((await origin.session(sessionId, "org-a")).segments.length, 2);
});

test("§6 — a KILLED tab's recording is offered back on the next load, with nothing waited out", async () => {
  const origin = new CaptureOrigin();
  const killed = origin.tab();
  await killed.surface.init();
  const sessionId = await recordOneChunk(killed);

  // THE destructive test, and the whole regression this round exists for. No
  // Stop, no teardown, no heartbeat — and, deliberately, NO CLOCK MOVEMENT
  // either: the meeting must be offered back on the FIRST check a reopened tab
  // makes, because that surface asks once on mount and nothing re-asks it. With
  // a staleness threshold in the way this is where a person was shown an empty
  // device holding a complete, playable meeting.
  killed.kill();

  const reopened = origin.tab();
  await reopened.surface.init();
  await reopened.surface.refreshRecoverable();
  assert.deepEqual(reopened.state.recoverable.map((entry) => entry.record.sessionId), [sessionId]);

  // …and it is really theirs again: playable, and deletable.
  const record = await origin.record(sessionId);
  assert.ok(record);
  await reopened.surface.previewCapture(record);
  await flush();
  assert.equal(reopened.state.preview?.sessionId, sessionId, "the audio comes back too");
  await reopened.surface.discard(record);
  await flush();
  assert.equal(reopened.state.createError, "", "no refusal — nobody is writing to it");
  assert.equal(await origin.record(sessionId), undefined, "and the audio is really gone");
});

test("§6 — a tab that RELOADS mid-recording can pick its own meeting straight back up", async () => {
  const origin = new CaptureOrigin();
  const before = origin.tab();
  await before.surface.init();
  const sessionId = await recordOneChunk(before);

  // A reload is a kill with a page after it. The desktop's equivalent stranded
  // the recording for good — main kept re-arming a heartbeat for a renderer
  // that no longer existed, so Transcribe, Create and Delete were all refused
  // for ever, blaming a window nobody could see. A lock cannot outlive its
  // context, so the new page finds it free.
  before.kill();

  const after = origin.tab();
  await after.surface.init();
  await after.surface.refreshRecoverable();
  const entry = after.state.recoverable.find((candidate) => candidate.record.sessionId === sessionId);
  assert.ok(entry, "the reloaded page is offered the recording it was making a second ago");
  await after.surface.pickUp(entry);
  await flush();
  assert.equal(after.state.createError, "");
  assert.equal(after.locks.holds(sessionId), true, "and it holds the recording now");
});

test("Stop hands the recording back at once, so another tab can pick it up", async () => {
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  const sessionId = await recordOneChunk(tab);
  await tab.stop();

  const stored = await origin.session(sessionId, "org-a");
  assert.equal(stored.status, "stopped");
  // The lock covers a capture being WRITTEN TO. The microphone is closed and
  // the last chunk has landed, so holding on past this point would keep a
  // finished meeting out of every other tab's offer for as long as this one
  // stayed open on the compose box.
  assert.equal(locked(origin, sessionId), false, "the lock is handed back with the recording");
  const offered = resumableCaptures(await origin.records(), { scope: { orgId: "org-a" }, at: new Date(origin.clock).toISOString() });
  assert.deepEqual(offered.map((entry) => entry.record.sessionId), [sessionId]);
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

test("the microphone prompt is not a window in which the recording looks abandoned", async () => {
  // REPRODUCED, and the reason the heartbeat had to go. `record()` started the
  // beat before `getUserMedia`, but the beat opened with `if (!queue || !claim)
  // return "unheld"` and `#queue` is only assigned after `openMicrophone()`
  // resolves — so for the entire length of the prompt NOTHING was written. At
  // 35 seconds a second tab's ordinary refresh reaped the session; the person
  // then clicked Allow and the chunk landed into a meeting that no longer
  // existed. Moving the lock acquisition below `openMicrophone()` reproduces
  // exactly that, here.
  const origin = new CaptureOrigin();
  const waiting = origin.tab();
  await waiting.surface.init();
  waiting.microphonePending = true;
  const pressed = waiting.start();
  await flush();

  const records = await origin.records();
  assert.equal(records.length, 1, "the session exists before the microphone does");
  const sessionId = records[0].sessionId;
  assert.equal(records[0].chunks.length, 0, "and holds no audio yet, which is the shape a reap reclaims");

  // Another tab, doing nothing unusual: it loads and checks for recoverable
  // recordings, which is also what runs the reap.
  const other = origin.tab();
  await other.surface.init();
  await origin.advance(35_000);
  await other.surface.refreshRecoverable();
  assert.ok(await origin.record(sessionId), "the session is still there when the prompt is answered");
  assert.deepEqual(other.state.recoverable, [], "and it was never offerable — nobody may pick up a recording being started");

  // Allow. The audio lands in the meeting it belongs to.
  waiting.answerMicrophone();
  await pressed;
  await flush();
  await waiting.chunk();
  assert.equal((await origin.record(sessionId))?.chunks.length, 1, "the chunk is on the device");
  assert.equal((await origin.session(sessionId, "org-a")).segments.length, 1, "and the meeting claims it");
});

test("a picked-up capture can be created from the tab that picked it up", async () => {
  const origin = new CaptureOrigin();
  const first = origin.tab();
  await first.surface.init();
  const sessionId = await recordOneChunk(first);
  await first.surface.dispose();
  await flush();

  const second = origin.tab();
  await second.surface.init();
  second.surface.setTitle("Picked up");
  await second.surface.refreshRecoverable();
  const entry = second.state.recoverable.find((candidate) => candidate.record.sessionId === sessionId);
  assert.ok(entry);
  await second.surface.pickUp(entry);
  await flush();
  // The tab now HOLDS the lock, so Create's "is another tab writing to this?"
  // must answer no for the tab that IS the other tab — a check that forgot to
  // ask whether the lock is its own would wedge this permanently.
  await second.surface.submit();
  await flush();
  assert.equal(second.posts.length, 1, second.state.createError);
  assert.equal(await origin.record(sessionId), undefined, "and the audio was released");
});

test("leaving the page hands back a recording this tab only PICKED UP", async () => {
  // The case Stop's release cannot cover, because there is no recorder to stop:
  // a capture picked up and still draining. `dispose()` is the only thing that
  // hands it back on a client-side navigation — the tab is still alive, so the
  // browser will not — and without it the meeting is invisible to every other
  // tab, and to this page's own next mount, until the tab is closed.
  const origin = new CaptureOrigin();
  const first = origin.tab();
  await first.surface.init();
  const sessionId = await recordOneChunk(first);
  await first.surface.dispose();
  await flush();

  const second = origin.tab();
  await second.surface.init();
  await second.surface.refreshRecoverable();
  const entry = second.state.recoverable.find((candidate) => candidate.record.sessionId === sessionId);
  assert.ok(entry);
  await second.surface.pickUp(entry);
  await flush();
  assert.equal(second.locks.holds(sessionId), true);

  await second.surface.dispose();
  await flush();
  assert.equal(locked(origin, sessionId), false, "the navigation hands the recording back");

  const third = origin.tab();
  await third.surface.init();
  await third.surface.refreshRecoverable();
  assert.deepEqual(third.state.recoverable.map((candidate) => candidate.record.sessionId), [sessionId]);
});

test("starting a NEW recording hands back the one this tab was holding", async () => {
  // A person picks a crashed meeting up, changes their mind and records a fresh
  // one. The queue is replaced, so the old capture has left this tab's hands —
  // and a lock kept for it would strand that meeting for every tab of this
  // browser until the page was closed.
  const origin = new CaptureOrigin();
  const first = origin.tab();
  await first.surface.init();
  const older = await recordOneChunk(first);
  await first.surface.dispose();
  await flush();

  const second = origin.tab();
  await second.surface.init();
  await second.surface.refreshRecoverable();
  const entry = second.state.recoverable.find((candidate) => candidate.record.sessionId === older);
  assert.ok(entry);
  await second.surface.pickUp(entry);
  await flush();

  const newer = await recordOneChunk(second);
  assert.notEqual(newer, older);
  assert.equal(locked(origin, older), false, "the picked-up meeting is let go");
  assert.equal(second.locks.holds(newer), true, "and the new recording is the one being held");
});

test("Create cannot finalize a capture a second tab has taken over", async () => {
  // DATA LOSS, and the one destructive path this file never tested. `submit()`
  // asked the lease question of `queue.session` — the queue's own in-memory
  // copy, which was last read before the other tab existed and therefore always
  // says the coast is clear. So the POST went through, `#release(true)`
  // finalized the capture, and the audio the OTHER tab was recording into was
  // deleted out from under it. The desktop has had a test for exactly this; the
  // browser had the defect instead.
  const origin = new CaptureOrigin();
  const first = origin.tab();
  await first.surface.init();
  first.surface.setTitle("Handed over");
  const sessionId = await recordOneChunk(first);
  await first.stop();

  // The person moves to another tab and carries on there.
  const second = origin.tab();
  await second.surface.init();
  await second.surface.refreshRecoverable();
  const entry = second.state.recoverable.find((candidate) => candidate.record.sessionId === sessionId);
  assert.ok(entry, "the stopped recording is offered to the second tab");
  await second.surface.pickUp(entry);
  await flush();
  assert.equal(second.locks.holds(sessionId), true);

  // …and the first tab, still showing the compose box, presses Create.
  await first.surface.submit();
  await flush();
  assert.equal(first.posts.length, 0, "nothing is posted");
  assert.match(first.state.createError, /cannot be created from this tab/i);
  assert.ok(await origin.record(sessionId), "and the audio the other tab is holding is still on the device");
  assert.equal((await origin.session(sessionId, "org-a")).status, "stopped", "nor was the capture finalized under it");

  // The tab that actually holds it can still create the meeting.
  second.surface.setTitle("Handed over");
  await second.surface.submit();
  await flush();
  assert.equal(second.posts.length, 1, second.state.createError);
  assert.equal(await origin.record(sessionId), undefined, "and only then is the audio released");
});

test("D7 — the outage backoff runs on the HARNESS clock, so this host's schedule is testable", async () => {
  // The queue's `now` port was passed by the desktop's supervisor and by nothing
  // here, so the scheduler read `Date.now()` while the surface read the port:
  // the probe window could not be crossed by a test at all, only by waiting real
  // seconds. Deleting `now: () => this.#ports.now()` from `#attachQueue` puts
  // the endpoint permanently inside its backoff below and this fails.
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  let attempts = 0;
  tab.transcribeSegment = async () => {
    attempts += 1;
    // D7: the endpoint declining to serve, which costs no retry budget and puts
    // the whole queue into a backed-off probe.
    if (attempts < 3) throw new SegmentTranscriptionError(503, "the sidecar is restarting");
    return "back from the outage";
  };
  await recordOneChunk(tab);

  assert.equal(tab.state.phase, "unavailable", "the surface says the endpoint is down, not that the segment failed");
  assert.equal(attempts, 1, "and it is not hammered while it is");
  assert.equal(tab.state.session?.segments[0]?.attempts, 0, "an outage costs the segment nothing");

  // Time passes on the harness clock and the wake timer fires. Both the surface
  // and the queue read it, so the probe is actually due when the timer says so.
  await origin.advance(30_000);
  assert.ok(attempts >= 2, `the endpoint is probed again (attempts: ${attempts})`);
  assert.match(tab.state.transcript, /back from the outage/, "and the meeting drains when it returns");
});

test("golden rule 23 — a browser without Web Locks says so, and still records", async () => {
  // `navigator.locks` needs a secure context, so a dashboard on plain http over
  // a LAN has none. The recording must still be durable — that is D1b, and it
  // does not depend on coordination — but the thing that is now WORSE must be
  // on screen, because a fallback nobody can see is indistinguishable from
  // working.
  const origin = new CaptureOrigin();
  const tab = origin.tab({ withoutLocks: true });
  await tab.surface.init();
  assert.match(tab.state.coordination, /cannot tell whether another tab is recording/i);

  tab.surface.setTitle("No locks here");
  const sessionId = await recordOneChunk(tab);
  await tab.stop();
  assert.equal((await origin.record(sessionId))?.chunks.length, 1, "the audio is durable regardless");

  // And Create is not wedged: refusing everything a browser cannot vouch for
  // would be a bigger outage than the one it guards against.
  await tab.surface.submit();
  await flush();
  assert.equal(tab.posts.length, 1, tab.state.createError);
  // …and a browser that HAS them says nothing at all, so the sentence means
  // something when it appears.
  assert.equal(origin.tab().surface.snapshot().coordination, "");
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
  const first = origin.tab();
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
  const reopened = origin.tab();
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
  const abandoned = origin.tab();
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

  const later = origin.tab();
  await later.surface.init();
  await later.surface.refreshRecoverable();

  const after = await origin.records();
  assert.equal(after.some((record) => record.sessionId === "mtg-orphan-metadata"), false, "it is gone");
  assert.deepEqual(later.state.recoverable, [], "and it was never offerable in the first place");
});

test("C — the reap survives a recording another tab begins after the caller took its listing", async () => {
  const origin = new CaptureOrigin();
  const reaper = origin.tab();
  await reaper.surface.init();

  // The one window `keep` structurally cannot cover: the reaping tab took its
  // own listing, and only then does another tab press Record. OPFS is scoped to
  // the origin, so the new session is invisible to the caller's list and present
  // in the reap's — and it holds no audio yet, which is exactly the shape defect
  // C reclaims.
  const recorder = origin.tab();
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
  assert.equal(locked(origin, survived[0].sessionId), true, "because the tab that started it is holding it");
});

test("C — but the reap leaves alone a recording another tab has only just begun", async () => {
  const origin = new CaptureOrigin();
  const recording = origin.tab();
  await recording.surface.init();
  await recording.record();
  const sessionId = recording.state.session?.id;
  assert.ok(sessionId, "the session exists before any audio does");
  assert.equal((await origin.record(sessionId))?.chunks.length ?? 0, 0, "and holds no audio yet");

  const other = origin.tab();
  await other.surface.init();
  await other.surface.refreshRecoverable();

  assert.ok(await origin.record(sessionId), "the microphone prompt is not a reason to delete a meeting");
  await recording.chunk();
  assert.equal((await origin.session(sessionId, "org-a")).segments.length, 1);
});

test("a manifest write that fails costs the meeting no audio, and the next load adopts the chunk", async () => {
  // The store having a bad moment must not cost somebody their recording. The
  // bytes land first and the session write is second, so a refused manifest
  // leaves the audio on the device and the segment merely unclaimed — and the
  // restore believes the chunks rather than the manifest, so the next load
  // takes it back into the meeting.
  const origin = new CaptureOrigin();
  const tab = origin.tab();
  await tab.surface.init();
  await recordOneChunk(tab);
  const sessionId = tab.state.session?.id ?? "";

  origin.backend.failManifestReads.add(sessionId);
  await tab.chunk();
  assert.equal((await origin.record(sessionId))?.chunks.length, 2, "the audio is written");
  assert.match(tab.state.warning, /The audio itself IS saved/);
  assert.equal((await origin.session(sessionId, "org-a")).segments.length, 2, "and the next load claims it back");
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

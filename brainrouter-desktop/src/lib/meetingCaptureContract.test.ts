/**
 * ADR-035 D1/D2 — a wiring test, because the defect it guards typechecks.
 *
 * Every failure this ADR exists to end is invisible to a unit test of any single
 * module: a recorder started without a timeslice still records, an
 * `ondataavailable` that pushes into an array still compiles, and a capture
 * channel that main never registers still has a preload method to call. What is
 * being asserted is that the pieces are connected to each other in the one
 * arrangement where the bytes survive.
 *
 * Asserted against source text and living under `src/` for the same reason as
 * the org-partition contract: this half of the desktop suite runs from SOURCE,
 * while the electron half runs from `dist-electron`, where no `.ts` file exists
 * to read.
 *
 * **What must NOT be added here.** Anything about a value being USED. A regex
 * sees that a call is written; it cannot see that its result is assigned, and
 * this file was green through four separate one-line changes that each lost a
 * real meeting — the live session never remembered, the compose box's mirror
 * never advanced, the progress filter reading a pinned empty hold, and Create
 * posting the box as of the last title keystroke. Those belong in
 * `components/meetings/meetingsView.test.tsx`, which renders the component and
 * asserts on what reaches the POST. The line between the two files is: wiring
 * that typechecks either way goes here; behaviour goes there.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

test('meeting audio is written on a cadence, through the host, and never held in the renderer', () => {
  const view = read('../components/meetings/MeetingsView.tsx');
  const recorder = read('../components/meetings/captureRecorder.ts');
  const ops = read('../components/meetings/captureOps.ts');

  // D1 — the timeslice. Without an argument here `MediaRecorder` is free to
  // deliver one blob at stop, and the disk write buys nothing.
  assert.match(recorder, /recorder\.start\(this\.chunkMs\)/);
  assert.match(recorder, /chunkMs = options\.chunkMs \?\? DEFAULT_MEETING_CHUNK_MS/);

  // D1 — a chunk goes straight to the host. There is no array of blobs anywhere.
  assert.match(recorder, /ondataavailable = \(event: BlobEvent\) =>[\s\S]{0,120}this\.enqueue\(sessionId, event\.data\)/);
  assert.match(recorder, /await this\.capture\.append\(sessionId, bytes, durationMs\)/);
  assert.doesNotMatch(recorder, /Blob\[\]|\.push\(/);
  assert.doesNotMatch(view, /chunksRef|Blob\[\]/);
  // The view no longer owns a recorder or a stream; both moved behind the class
  // that cannot accumulate audio.
  assert.doesNotMatch(view, /new MediaRecorder\(/);
  assert.doesNotMatch(view, /streamRef/);
  // D1/ADR-028 — a chunk that could not be written reports into its OWN state.
  // `setError` is cleared at the top of every later action (`adoptCapture`
  // opens with `setError("")`), so routing it there meant pressing Stop erased
  // the only evidence that part of the meeting was never saved.
  assert.match(view, /new MeetingCaptureRecorder\(\{ capture, onChunkError: setCaptureIssue \}\)/);
  assert.doesNotMatch(view, /onChunkError: setError/);

  // D2 — the session (and its directory) exists before the recorder is started.
  const beginAt = recorder.indexOf('await this.capture.begin(');
  const startAt = recorder.indexOf('recorder.start(this.chunkMs)');
  assert.ok(beginAt > 0 && startAt > beginAt);

  // The renderer holds no filesystem path and no audio buffer: its only route to
  // durability is the bridge, and it refuses to record when that route is absent.
  assert.match(ops, /captureAppend!\(id, bytes, durationMs\)/);
  assert.match(view, /if \(!capture\.available\)/);

  // D2 — the offer is queried where the user lands after a crash (the library),
  // not only inside a compose form they would have to think to open.
  //
  // F1 — and BOTH ask it to leave out the captures in hand. `isResumableSession`
  // deliberately does not narrow on `recording` (a clean quit leaves audio that
  // never transcribed), so the live recording satisfied D2's predicate and the
  // library offered to transcribe it — or DELETE it, with no confirmation and
  // no guard — while its own microphone was still open.
  //
  // Invariant 5 — the HAND, not the one capture the live rows are bound to. Both
  // read `inHand` because Record → Stop → Record leaves the first capture held
  // and unbound, and the version that excluded only `hold.sessionId` offered it
  // straight back while the second half was still being recorded.
  assert.match(view, /capture\.resumable\(\{ orgId: scopedOrgId \?\? null \}, heldCaptureIds\.length \? \{ exclude: heldCaptureIds \} : \{\}\)/);
  assert.match(view, /capture\.resumable\(captureScope, hold\.inHand\.length \? \{ exclude: hold\.inHand \} : \{\}\)/);
  // …and the delete that used to be one unguarded click is confirmed, and
  // refused outright while the capture is still being written to.
  assert.match(view, /Discard this unfinished recording\? Its audio is deleted from this device\./);
  assert.match(view, /if \(hold\.sessionId === sessionId && captureInFlight\(hold\)\) return;/);
  // ADR-028 — and a recovery query that FAILED does not render as "nothing to
  // recover". A swallowed rejection here loses this ADR's whole deliverable
  // silently, on exactly the launch where the user is looking for it.
  assert.doesNotMatch(view, /resumable\([^)]*\)[\s\S]{0,220}catch\(\(\) => undefined\)/);
  // D6 — nor is a failed release of the audio swallowed: the session would stay
  // non-terminal and the next launch would call a meeting that SUCCEEDED an
  // interrupted recording.
  assert.doesNotMatch(view, /capture\.finalize\([^)]*\)\.catch\(/);
  assert.match(view, /onAudioRetained\(\{ sessionId, message:/);
});

test('invariant 5 — a capture is in hand from Record until it is FILED, and every one of them is released', () => {
  const view = read('../components/meetings/MeetingsView.tsx');
  const submit = read('../components/meetings/composeSubmit.ts');

  // The hand is a LIST and `sessionId` is only the live binding. The behaviour
  // is asserted for real in `meetingsView.test.tsx` (record → Stop → record →
  // Create); what is pinned here is that there is one writer of the list and one
  // way out of it, because a second assignment anywhere would typecheck.
  assert.match(submit, /readonly inHand: readonly string\[\];/);
  assert.match(submit, /file\(sessionId: string\): MeetingCaptureHold;/);
  assert.match(submit, /export type CaptureHoldPatch = Partial<Omit<MeetingCaptureHold, "inHand">>;/);
  // …so nothing outside the store can put a capture into the hand or take one
  // out of it. `update({ sessionId: null })` is what USED to release a capture,
  // and it released nothing but the rendering.
  assert.doesNotMatch(view, /update\(\{ inHand/);
  assert.doesNotMatch(view, /inHand: \[/);

  // Create releases the whole hand, and the hand is read BEFORE the create's
  // await: a capture picked up while the POST is in flight is not part of the
  // meeting being created, and finalizing it would delete audio that meeting
  // does not contain. Positional, because both orders typecheck and both look
  // right.
  const filingAt = view.indexOf('const filing = holdStore.current.inHand;');
  const postAt = view.indexOf('await ops.createFromTranscript(prepared.input, prepared.orgId)');
  assert.ok(filingAt > 0 && postAt > filingAt, 'the hand is snapshotted before the create');
  const loopAt = view.indexOf('for (const sessionId of filing) {');
  const retainAt = view.indexOf('onAudioRetained({ sessionId, message:', loopAt);
  const fileAt = view.indexOf('holdStore.file(sessionId);', loopAt);
  // Filed AFTER the catch, so on both branches of the release: a finalize that
  // failed is still a capture this form has finished with, and leaving it in the
  // hand keeps excluding it from the offer that is now the only way back to it.
  assert.ok(loopAt > 0 && retainAt > loopAt && fileAt > retainAt, 'each capture is filed whether or not its release succeeded');
  // Two callers, and there are exactly two ways a capture is filed: the create
  // releases it, or a discard deletes it.
  assert.equal(view.match(/holdStore\.file\(/g)?.length, 2);
});

test('G2 — the rules that guard Record and Pick up are in the functions, not on the pixels', () => {
  const view = read('../components/meetings/MeetingsView.tsx');

  // A `disabled` is a statement about a pixel: React renders it a commit late,
  // so a second handler arriving in the same commit reaches the function with
  // the attribute still false. Two Records in one commit gave two `captureBegin`
  // calls and two microphone streams, and Stop reached only the second — main
  // subtracts live writers from the offer, so NO row existed anywhere for the
  // first and nothing in the app could stop it.
  //
  // The refusal is the first statement of each function and reads the
  // synchronous hold. Behaviour is asserted in `meetingsView.test.tsx`; what is
  // pinned here is that it comes before anything is mutated or awaited.
  const recordAt = view.indexOf('const startRecording = useCallback(async () => {');
  assert.ok(recordAt > 0);
  assert.match(
    view.slice(recordAt, recordAt + 620),
    /useCallback\(async \(\) => \{(?:\n\s*\/\/[^\n]*)*\n\s*if \(captureInFlight\(holdStore\.current\)\) return;/,
    'Record refuses before it clears an error, builds a recorder or opens a microphone',
  );
  const adoptAt = view.indexOf('const adoptCapture = useCallback(async (sessionId: string) => {');
  // Invariant 5 — the WIDE rule, and only here. A pick-up takes on a SECOND
  // meeting, so anything already in hand forbids it; Record does not, because
  // Record -> Stop -> Record is two takes of one meeting and Create files both.
  assert.ok(adoptAt > 0 && view.indexOf('if (captureInHand(holdStore.current)) return;', adoptAt) > adoptAt);
  // And the pick-up raises `arming` BEFORE its IPC, which is what makes the
  // narrow rule above cover it: a Record landing inside `capture.adopt` started
  // a second capture, and Create then finalized — deleted — the recovered
  // meeting without one of its words reaching the box.
  const armAt = view.indexOf('holdStore.update({ sessionId, arming: true });', adoptAt);
  assert.ok(armAt > adoptAt && armAt < view.indexOf('await capture.adopt(sessionId)'));
  assert.match(view.slice(adoptAt), /finally \{ holdStore\.update\(\{ arming: false \}\); \}/);
  assert.ok(
    view.indexOf('if (captureInHand(holdStore.current)) return;', adoptAt) < view.indexOf('await capture.adopt(sessionId)'),
    'a pick-up refuses before it takes the recording',
  );
  // The two controls that can TAKE ON another capture read the wide rule; Create
  // and Delete deliberately do not, because filing is how a capture leaves the
  // hand and gating those would leave the state with no exit.
  assert.match(view, /disabled=\{Boolean\(busy\) \|\| holding \|\| lockedIds\.has\(row\.sessionId\)\} onClick=\{\(\) => void adoptCapture/);
  assert.match(view, /const holding = captureInHand\(hold\);/);
});

test('a capture is transcribed segment by segment, by the host, and the 40 MB refusal is import-only', () => {
  const view = read('../components/meetings/MeetingsView.tsx');
  const ops = read('../components/meetings/captureOps.ts');

  // D3 — the body limit belonged to a design where the whole capture was posted
  // in one request. Nothing does that any more, so the recovery card's
  // "Transcribe it" no longer promises something that path would always refuse.
  assert.match(view, /if \(blob\.size > MAX_AUDIO_BYTES\)/);
  assert.match(view, /const importAudio[\s\S]{0,160}transcribeFile\(file\)/);
  // The renderer never reads a capture back TO TRANSCRIBE it: "transcribe this
  // recording" is a request that main start draining, so the bytes stay in main
  // and a meeting past 40 MB is therefore not a meeting that fails.
  assert.match(view, /capture\.adopt\(sessionId\)/);
  assert.doesNotMatch(view, /transcribeAudio\(\{[\s\S]{0,120}capture\.read\(/);
  // There is exactly ONE place the renderer reads a recording back, and it is
  // §6's other criterion — "the audio up to the kill must be on disk and
  // PLAYABLE", which a recovery card that can only offer "transcribe it" cannot
  // answer for a user whose STT endpoint is down.
  assert.equal(view.match(/capture\.read\(/g)?.length, 1);
  assert.match(view, /const playCapture = useCallback\(async \(sessionId: string\)[\s\S]{0,420}await capture\.read\(sessionId\)/);
  // …and the object URL is a handle on a whole recording held in this window's
  // heap, so it is released rather than leaked — §1's defect in miniature. Twice
  // over: the effect revokes the one this form is showing, and the read-back
  // refuses to mint one at all for a form whose life has ended — see
  // `createComposeLife`, and `meetingsView.test.tsx` for the assertion that a
  // form which has gone leaks nothing.
  assert.match(view, /URL\.revokeObjectURL\(preview\.url\)/);
  assert.match(view, /const life = formLife\.begin\(\);/);
  assert.match(view, /if \(formLife\.ended\(life\)\) return;/);

  // Open question 3 — the queue is HOST-owned. A renderer that constructed one
  // would lose it on the next reload, which is the defect this ADR is about.
  assert.doesNotMatch(view, /createMeetingTranscriptionQueue/);
  assert.doesNotMatch(ops, /createMeetingTranscriptionQueue/);
});

test('the transcription queue lives in main and pushes every persisted change', () => {
  const bridge = read('../../electron/meetingCaptureBridge.ts');
  const channels = read('../../electron/meetingCaptureChannels.ts');
  const supervisor = read('../../electron/meetingTranscription.ts');
  const preload = read('../../electron/preload.cts');
  const declarations = read('../bridge.d.ts');

  assert.match(bridge, /new MeetingTranscriptionSupervisor\(/);
  // The shared queue, not a second one: the retry rule and the outage rule are
  // the same on both hosts or they are not shared at all.
  assert.match(supervisor, /createMeetingTranscriptionQueue\(/);
  // No attempt bound, no delay curve, no policy of its own — those names would
  // only appear here if this file had started restating the shared rule.
  assert.doesNotMatch(supervisor, /maxAttempts|retryDelayMs|DEFAULT_MEETING_RETRY_POLICY|retryDecision/);
  // D3 — `MediaRecorder` puts the container header in the FIRST chunk only, so a
  // host that hands a later chunk to the queue untouched transcribes segment 0
  // and nothing else. The framing is pure byte inspection with no filesystem in
  // it, so it is core's (D1b) and this host supplies only the chunks — a second
  // copy here is how the two hosts start disagreeing about what a segment is.
  assert.match(supervisor, /readSegment: createSegmentAudioReader\(\{/);
  assert.doesNotMatch(supervisor, /initializationSegmentLength|segmentUploadBytes|CLUSTER/);

  for (const channel of ['captureAdopt', 'captureRetrySegment']) {
    assert.match(channels, new RegExp(`host\\.handle\\('meetings:${channel}'`), `main handles meetings:${channel}`);
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('meetings:${channel}'`), `preload invokes meetings:${channel}`);
    assert.match(declarations, new RegExp(`${channel}\\?\\(`), `bridge.d.ts declares ${channel}`);
  }
  // D4 — progress is pushed, not polled, and only after the write.
  assert.match(bridge, /publish: \(progress\) => \{ broadcast\(MEETING_CAPTURE_PROGRESS_CHANNEL, progress\); \}/);
  assert.match(bridge, /window\.webContents\.send\(channel, payload\)/);
  assert.match(preload, /ipcRenderer\.on\('meetings:capture-progress'/);
  const persistAt = supervisor.indexOf('await this.#store.persist(next)');
  const publishAt = supervisor.indexOf('this.#publish({ sessionId: id, session: next })');
  assert.ok(persistAt > 0 && publishAt > persistAt);
});

test('D1/D9 still hold through the supervisor: bytes first, then ledger, then units', () => {
  const store = read('../../electron/meetingCapture.ts');
  const supervisor = read('../../electron/meetingTranscription.ts');

  // The store writes bytes and no longer extends a record AT ALL: D3's queue is
  // the single writer of an open capture, and the boot pass's one exception —
  // claiming a durable chunk the kill landed on top of (§6, "the audio up to the
  // kill") — is now the shared rule's. Both hosts had written that rule for
  // themselves and both comments admitted nothing kept the two aligned, so a
  // second copy reappearing here is the drift D1b is about.
  assert.match(store, /adoptCaptureChunks\(session, chunks\)/);
  assert.doesNotMatch(store, /appendSegment\(|resumeCapture\(/);
  const sequenceAt = supervisor.indexOf('nextChunkSequence(entry.queue.session)');
  const writeAt = supervisor.indexOf('await this.#store.writeSegment(id, sequence, bytes)');
  const recordAt = supervisor.indexOf('{ byteLength: written, durationMs }');
  assert.ok(sequenceAt > 0 && writeAt > sequenceAt && recordAt > writeAt);
  // D6 — and the commit carries nothing else. The append used to fold a lease
  // heartbeat into it, which is a clock standing in for a fact main already had;
  // gating the audio path on any part of that is the loss this ADR exists to
  // prevent arriving through the door meant to stop it.
  assert.match(supervisor, /sealDueUnits\(appendChunk\(current, \{ byteLength: written, durationMs \}\)\)/);
});

test('D6 — liveness is the process\'s own answer, and nothing on this host reads a lease', () => {
  const supervisor = read('../../electron/meetingTranscription.ts');
  const store = read('../../electron/meetingCapture.ts');
  const view = read('../components/meetings/MeetingsView.tsx');
  const submit = read('../components/meetings/composeSubmit.ts');
  const main = read('../../electron/main.ts');

  // The registry, in the one place that can hold it: a supervisor created once
  // per PROCESS, which is the unit every BrowserWindow lives in. The behaviour
  // is asserted for real in `meetingTranscription.test.ts` and
  // `meetingCaptureChannels.test.ts`; what is asserted here is that no second
  // answer to the same question has grown back.
  assert.match(supervisor, /readonly #writers = new Map<string, string>\(\);/);
  // Nothing on this host may ask the lease anything — not the supervisor, not
  // the store, not the surface, not the rule behind Create. Every name below is
  // a CALL rather than a word, because the comments in those files argue at
  // length about why the lease is gone and should go on being able to.
  //
  // It failed in the direction that costs a meeting: a window RELOAD left main
  // renewing a lease for a renderer that no longer existed, so Transcribe,
  // Create and Delete were refused for ever over a recording nobody was making.
  const leaseCalls = /acquireCaptureLease|heartbeatCaptureLease|releaseCaptureLease|isCaptureBeingWritten|capturesBeingWritten|describeCaptureWriter|captureLeaseStaleAt|MEETING_CAPTURE_HEARTBEAT_MS|MEETING_CAPTURE_LEASE_STALE_MS/;
  for (const source of [supervisor, store, view, submit]) assert.doesNotMatch(source, leaseCalls);
  // …and the two-PROCESS case is prevented rather than detected, which is the
  // only thing that makes one process's answer complete.
  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
  // D6 — the boot pass is TOLD who is recording rather than reading it off the
  // record, and it guards the whole pass rather than one of its three
  // destructive halves.
  assert.match(store, /if \(isWriting\(id\)\) \{ sessions\.push\(stored\.session\); continue; \}/);
});

test('live text distinguishes provisional from settled, and the fold rule is the SHARED one', () => {
  const view = read('../components/meetings/MeetingsView.tsx');

  // D4 — the box is APPENDED to, never re-rendered from the session. A
  // `setTranscript(transcriptText(session))` anywhere here would compile, look
  // right, and delete a correction the user made twenty seconds earlier.
  assert.match(view, /foldTranscript\(transcriptRef\.current, session, foldRef\.current\)/);
  assert.doesNotMatch(view, /setTranscript\(transcriptText\(/);
  // D4 — and the three states are rendered as three different things.
  assert.match(view, /entry\.state === "transcribing" \? "Transcribing…" : "Queued"/);
  assert.match(view, /transcriptSoFar\(session\)/);
  assert.match(view, /onRetry\(entry\.index\)/);

  // D1b — the fold itself is no longer this host's. It lived in
  // `liveTranscript.ts` here while the dashboard recomposed `base +
  // transcriptText(session)` on every drain, which relocated a note typed
  // between two segments to the top of the meeting after a kill. Two hosts, one
  // compose box, two answers — so the append rule moved to core and this file
  // now has nowhere to keep a second one.
  assert.match(view, /foldTranscript,[\s\S]{0,400}from "@kinqs\/brainrouter-core\/meetings"/);
  assert.doesNotMatch(view, /from "\.\/liveTranscript\.js"/);
  assert.doesNotMatch(view, /formatCaptureGap|planTranscription/);
});

test('a recovered capture is folded in once, through the shared reconciliation', () => {
  const view = read('../components/meetings/MeetingsView.tsx');

  // The fatal defect this guards: a restored draft ALREADY holds the capture's
  // settled segments, so resetting the fold to empty before adopting appended
  // every one of them a second time — and the doubled text is what was POSTed
  // and summarized. The rule is shared with the dashboard, which had the same
  // bug in its own dialect (D1b).
  assert.match(view, /reconcileCaptureDraft\(transcriptRef\.current, session\)/);
  // Through the shared `beginTranscriptFold` rather than assembled here: a
  // resume point a host builds for itself is one it can build wrongly, and the
  // wrong one appends the whole meeting a second time.
  assert.match(view, /foldRef\.current = beginTranscriptFold\(reconciled\)/);
  // …and it has to run BEFORE the fold, which is what `applySession` does.
  const reconcileAt = view.indexOf('const reconciled = reconcileCaptureDraft(transcriptRef.current, session)');
  const applyAt = view.indexOf('applySession(session);', reconcileAt);
  assert.ok(reconcileAt > 0 && applyAt > reconcileAt);
  // The remaining empty fold is `startRecording`'s, where `begin` has just
  // minted a session with no segments and there is genuinely nothing to
  // reconcile against.
  assert.equal(view.match(/foldRef\.current = EMPTY_TRANSCRIPT_FOLD/g)?.length, 1);

  // E — and the recovered meeting comes back with its own NAME, which the
  // recovery card is already displaying two lines above the empty title box.
  // Create is disabled without one, so a crash used to end with the user
  // retyping a title the surface could see and they could not.
  assert.match(view, /if \(session\.title\) setTitle\(\(current\) => current \|\| session\.title\)/);
});

test('D6 — the draft lives where the audio does, and is the compose box itself', () => {
  const view = read('../components/meetings/MeetingsView.tsx');
  const ops = read('../components/meetings/captureOps.ts');
  const legacy = read('../components/meetings/legacyDraft.ts');
  const channels = read('../../electron/meetingCaptureChannels.ts');
  const preload = read('../../electron/preload.cts');
  const declarations = read('../bridge.d.ts');
  const drafts = read('../../electron/meetingDraft.ts');

  // "Audio is never written to `localStorage` or any renderer-accessible store.
  // The existing text draft should move to the same protected location for the
  // same reason." Nothing writes that key any more, and the one read left that
  // empties it lives in a module of its own — because it has to run when the
  // meetings view opens, not when someone gets as far as the compose form.
  // (Naming the store in a comment is how a fallback to it is argued against,
  // here as in the adapter below, so only a CALL is refused.)
  assert.doesNotMatch(view, /localStorage\.\w/);
  assert.match(legacy, /storage\.removeItem\(LEGACY_DRAFT_KEY\)/);
  // …and it is BUILT in render and RUN from an effect, which is the difference
  // between a migration and a lost draft. React may call a component body twice
  // for one commit and keep the second result — StrictMode's double render, on
  // every mount in `vite dev` — and the second run of a read-and-remove finds an
  // empty store. Started from the memo, the draft came out of `localStorage` and
  // the only promise still holding it was the discarded one, so an old preload
  // or a failed write lost it outright and the compose form's restore awaited a
  // hand-over that had never happened. Two `run()` calls and no more: the view's
  // effect and the form's restore, both answered by the same single run.
  assert.match(view, /const legacyDraft = useMemo\(\(\) => createLegacyDraftMigration\(capture\), \[capture\]\);/);
  assert.match(view, /useEffect\(\(\) => \{ void legacyDraft\.run\(\); \}, \[legacyDraft\]\);/);
  assert.match(view, /const pending = await legacyDraft\.run\(\);/);
  assert.equal(view.match(/legacyDraft\.run\(\)/g)?.length, 2);
  // And the form waits for it BEFORE it reads the protected file. Reading first
  // finds a file the hand-over has not written yet, and the 250 ms autosave that
  // `draftLoaded` releases a moment later then clears it over the migrated
  // words — the same loss, arrived at from the other end.
  assert.ok(
    view.indexOf('const pending = await legacyDraft.run();') < view.indexOf('const saved = (await capture.readDraft()'),
    'the compose form awaits the migration before it reads the protected draft',
  );
  // …and no fallback to it from the adapter either, which is where a "the host
  // is unavailable" branch would be tempting. (Naming the store in a comment is
  // how that branch is argued against, so only a CALL is refused here.)
  assert.doesNotMatch(ops, /localStorage\.\w/);

  for (const channel of ['draftRead', 'draftWrite', 'draftClear']) {
    assert.match(channels, new RegExp(`host\\.handle\\('meetings:${channel}'`), `main handles meetings:${channel}`);
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('meetings:${channel}'`), `preload invokes meetings:${channel}`);
    assert.match(declarations, new RegExp(`${channel}\\?\\(`), `bridge.d.ts declares ${channel}`);
  }
  // The same protected location, with the same modes as the audio beside it.
  assert.match(drafts, /MEETING_CAPTURE_DIRECTORY/);
  assert.match(drafts, /DIRECTORY_MODE = 0o700/);
  assert.match(drafts, /FILE_MODE = 0o600/);

  // C — the draft is the WHOLE box. Stripping the capture's settled segments out
  // of it kept the transcript out of `localStorage`, which stopped being the
  // question the moment the draft moved into the 0600 file the audio is in; what
  // it left was a saved draft that no longer said what the box said, and a
  // recovery that reconciled it against the same session came back with a
  // doubled edit, an undone deletion, a relocated note, or — worst — a kept line
  // matching a later segment and silently swallowing the minutes before it.
  assert.match(view, /capture\.writeDraft\(\{ title, transcript, /);
  assert.doesNotMatch(view, /reconcileCaptureDraft\(transcript, session\)\.retained/);
  assert.doesNotMatch(view, /transcript: owned/);
  // The reconciliation stays exactly where it is right: over a box whose
  // contents are what they claim to be, as an in-memory recompose base. One
  // call, and it is `adoptCapture`'s.
  assert.equal(view.match(/= reconcileCaptureDraft\(/g)?.length, 1);
  assert.match(view, /const reconciled = reconcileCaptureDraft\(transcriptRef\.current, session\);/);
});

test('what Create posts is decided in one tested place, and the view assembles none of it', () => {
  const view = read('../components/meetings/MeetingsView.tsx');
  const submit = read('../components/meetings/composeSubmit.ts');

  // M1 — the settle step was four lines inside `submit`, and deleting
  // `body = settled.text` left every renderer test and this whole file green
  // while the POST lost a gap marker and the segment behind it. A step whose
  // result the caller can quietly drop is a step no assertion can hold, so the
  // result is the entire create input and there is nothing left here to build.
  assert.match(view, /const prepared = prepareSubmission\(\{/);
  assert.match(view, /if \(!prepared\.ok\) return;/);
  assert.match(view, /ops\.createFromTranscript\(prepared\.input, prepared\.orgId\)/);
  assert.doesNotMatch(view, /createFromTranscript\(\{/);
  // D5 — and the settle is the SHARED rule, at the one moment it is
  // irreversible: `finalizeCapture` follows the create and deletes the audio.
  assert.match(submit, /settleTranscriptForSubmit\(state\.transcript, state\.session, state\.fold\)/);
  assert.match(submit, /transcript: settled\.text/);

  // Open question 5 — "a recording that started under one org must not silently
  // land in another." The active org comes from the app-wide switcher and can
  // move mid-meeting; the capture's scope is frozen at Record.
  assert.match(submit, /state\.session \? state\.session\.scope\.orgId \?\? undefined : state\.activeOrgId/);
});

test('F3 — Create cannot delete a recording out from under itself, and Stop is not instantaneous', () => {
  const view = read('../components/meetings/MeetingsView.tsx');
  const submit = read('../components/meetings/composeSubmit.ts');

  // D4 fills the transcript box live, so a RUNNING meeting satisfies every other
  // condition on this button within twenty seconds — and `submit` finalizes the
  // capture, which under D6 removes the directory the recorder is appending to.
  //
  // `recording` alone did not cover it. `stopRecording` sets it false on its
  // first line and THEN awaits `onstop`, the final chunk's `arrayBuffer`, the
  // IPC and the disk write; a Create 4 ms into that window posted a transcript
  // missing its last chunk with no gap marker — there was no segment for
  // anything to state — and then released the audio. Record has the same window
  // in the other direction, and `getUserMedia` can sit on a permission prompt.
  assert.match(submit, /return hold\.recording \|\| hold\.arming \|\| hold\.closing;/);
  assert.match(view, /holdStore\.update\(\{ arming: true \}\)/);
  // G1 — and the recorder is parked where the unmount teardown can reach it
  // BEFORE the same await, or leaving Meetings during the microphone prompt
  // stops nothing at all. Positional, like the two above, because both orders
  // typecheck; what the parked recorder then DOES is asserted in
  // `meetingsView.test.tsx`.
  const parkedAt = view.indexOf('recorderRef.current = recorder;');
  const armedAt = view.indexOf('await recorder.start({');
  assert.ok(parkedAt > 0 && armedAt > parkedAt, 'the recorder is reachable before the first await');
  assert.match(view, /holdStore\.update\(\{ recording: false, closing: Boolean\(recorder\) \}\)/);
  // In a `finally`, so a settle that THREW cannot wedge Create for good.
  assert.match(view, /\} finally \{ holdStore\.update\(\{ closing: false \}\); \}/);
  // The rule reads the values that are true NOW; the button reads the ones React
  // last rendered. A disabled attribute is a statement about a pixel.
  assert.match(view, /hold: holdStore\.current, busy: Boolean\(busy\)/);
  // `heldByAnother` is the D6 half — a capture main says a SECOND window is
  // recording, which this window's hold reads false about because the hold is
  // this window's memory. It is asserted behaviourally in `meetingsView.test.tsx`;
  // here it only has to not have been dropped from the button.
  assert.match(view, /disabled=\{!title\.trim\(\) \|\| !transcript\.trim\(\) \|\| Boolean\(busy\) \|\| capturing \|\| heldByAnother\}/);
  // …and it says why it is refusing rather than silently doing nothing.
  assert.match(view, /hold\.closing \? "Saving the recording…"/);
  // Record is off during both windows too. `recording` is false in each of them,
  // so the button that starts a capture was live while one was being armed or
  // closed — a second recorder over the first, and two microphones on one
  // meeting.
  assert.match(view, /onClick=\{\(\) => void startRecording\(\)\} disabled=\{Boolean\(busy\) \|\| capturing\}/);
});

test('the surface renders the whole of what the host publishes, not just the session', () => {
  const view = read('../components/meetings/MeetingsView.tsx');

  // ADR-028 — main computes a durability failure, publishes it, and preload
  // forwards it, so the surface is the last place it can be dropped. A `persist`
  // that threw means the RECORD is stale on disk: the live rows can sit at
  // "Transcribing…" for ever while nothing more is ever written down, which is
  // the failure this ADR is trying to end, wearing a spinner.
  assert.match(view, /if \(progress\.errors\?\.length\)/);
  assert.match(view, /setRecordIssue\(/);
  // D7 — an outage leaves every queued segment at `pending` with nothing spent,
  // so a queue waiting on a dead endpoint renders exactly like one that is
  // working. That difference exists only in the drain phase.
  assert.match(view, /if \(progress\.phase\) setPhase\(progress\.phase\)/);
  // F/D1b — the SENTENCE those states turn into is core's, not this host's. It
  // was written twice and the two copies had already drifted ("these segments
  // transcribe when it comes back" here, "WILL transcribe" on the dashboard),
  // which is the difference between two hosts making one promise and two hosts
  // making two. That includes the branch that fires rarest and matters most —
  // the refunds being spent — so the desktop must not restate any of it.
  assert.match(view, /capturePhaseNote\(session, phase, \{ gaps, provisional \}\)/);
  assert.doesNotMatch(view, /function phaseNote\(/);
  assert.doesNotMatch(view, /MEETING_ENDPOINT_UNRESPONSIVE_REASON/);
  assert.doesNotMatch(view, /The transcription service is not answering/);
});

test('A1 — navigating away from the compose form does not end the meeting', () => {
  const view = read('../components/meetings/MeetingsView.tsx');

  // The defect: the recorder lived inside `<NewMeeting/>`, whose only unmount
  // cleanup released the microphone, and FOUR ordinary clicks unmounted it
  // mid-recording — Cancel, opening a meeting from the library, the Track/Teams
  // tabs, and the workspace switcher. Nothing said the recording had ended,
  // because the state that knew was in the component that just went away.
  //
  // The decision, matching the dashboard (D1b): navigation does NOT stop the
  // recording. The form stays mounted while `recording` is true and is merely
  // hidden, and an indicator above the tab switch leads back to it.
  assert.match(view, /\{composing \|\| capturing \? \(/);
  assert.match(view, /display: composeVisible \? "contents" : "none"/);
  assert.match(view, /const composeVisible = composing && mode === "meetings";/);
  assert.match(view, /\{mode === "meetings" \|\| capturing \? \(/);
  assert.match(view, /onCaptureHold=\{setHold\}/);
  assert.match(view, /useEffect\(\(\) => \{ onCaptureHold\(hold\); \}/);
  // …and released on unmount, so the library stops excluding a capture nobody
  // holds any more (F1). Its own effect, so it runs only then.
  assert.match(view, /useEffect\(\(\) => \(\) => onCaptureHold\(NO_CAPTURE_HOLD\), \[onCaptureHold\]\)/);
  // The indicator, and the way back. It is rendered before the tab switch so it
  // survives the two tabs that replace everything below it.
  const barAt = view.indexOf('capturing && !composeVisible ?');
  const tabsAt = view.indexOf('{mode === "tracked" ? <MeetingTracksView');
  assert.ok(barAt > 0 && tabsAt > barAt, 'the recording indicator is rendered above the tab switch');
  assert.match(view, /A meeting is being recorded\. Its audio is being saved to this device\./);
  assert.match(view, /setMode\("meetings"\); setSelectedId\(null\); setComposing\(true\);/);

  // And when the form really does go — the meetings view itself unmounting —
  // the capture is CLOSED rather than abandoned. `dispose` stopped the
  // microphone without telling the store, so the session stayed
  // `status: "recording"` and the library advertised the user's own click as an
  // interrupted recording.
  assert.doesNotMatch(view, /recorderRef\.current\?\.dispose\(\)/);
  assert.match(view, /formLife\.retire\(\);\s*\n\s*const recorder = recorderRef\.current;\s*\n\s*recorderRef\.current = null;\s*\n\s*void recorder\?\.stop\(\);/);
});

test('F4 — the fifth click: the mode rail does not end the meeting either', () => {
  const shell = read('../App/layout/MainContent.tsx');
  const view = read('../components/meetings/MeetingsView.tsx');

  // A1 kept the composer mounted through the four clicks INSIDE the meetings
  // view. The activity-bar rail still ended a live meeting silently, because
  // this shell rendered `<MeetingsView/>` only while its mode was selected:
  // switching to Code left the recorder inactive, the microphone tracks
  // stopped and the session stopped, with nothing on screen saying so.
  //
  // Same decision as A1's, one level up: mounted while a capture is open,
  // merely hidden, with an app-level indicator that leads back.
  assert.match(shell, /\{meetingsVisible \|\| meetingCapture \? \(/);
  assert.match(shell, /ref=\{meetingsVisible \? workrowRef : null\}/);
  assert.match(shell, /meetingsVisible \? \{\} : \{ style: \{ display: 'none' \} \}/);
  assert.match(shell, /<MeetingsView ops=\{meetingsOps\} onCaptureChange=\{setMeetingCapture\} \/>/);
  // Exactly one mount: a second `<MeetingsView/>` in the mode chain would be a
  // second recorder, a second microphone and two windows onto one capture.
  assert.equal(shell.match(/<MeetingsView /g)?.length, 1);
  // …and the mode chain no longer claims the meetings branch, or the view would
  // render twice while the mode is selected.
  assert.match(shell, /\{meetingsVisible \? null : mode === 'notes' \? \(/);
  assert.doesNotMatch(shell, /\) : mode === 'meetings' \? \(/);

  // ADR-028 — the recording did not stop when the screen did, so something says
  // so from wherever the person went, and it is a way back rather than a notice.
  assert.match(shell, /\{meetingCapture && !meetingsVisible \? \(/);
  assert.match(shell, /A meeting is being recorded\. Its audio is being saved to this device\./);
  assert.match(shell, /onClick=\{\(\) => setMode\('meetings'\)\}/);

  // The view answers with the same fact its own indicator uses — the state
  // itself, reported from an effect, so the two cannot drift.
  assert.match(view, /useEffect\(\(\) => \{ onCaptureChange\?\.\(capturing\); \}, \[capturing, onCaptureChange\]\)/);
});

test('B — unreadable saved chunks are stated, not thrown at the whole recording', () => {
  const view = read('../components/meetings/MeetingsView.tsx');
  const store = read('../../electron/meetingCapture.ts');
  const ops = read('../components/meetings/captureOps.ts');
  const readSegmentStart = store.indexOf('async readSegment');
  const chunkReader = store.slice(readSegmentStart, store.indexOf('\n  /**', readSegmentStart));

  // §6 judges this on the audio being "on disk AND playable". A `readFile` per
  // claimed chunk with no guard meant one missing file rejected the whole
  // concatenation: fifty-nine other minutes on disk and unreachable, with the
  // recovery card still advertising their byte count and the user shown an
  // errno. D9 requires playback to start from the ledger, including its open
  // suffix, then extend through every preserved physical sequence instead of
  // considering only sealed transcription units or a contiguous file prefix.
  assert.match(store, /const sequences = new Set\(captureChunks\(stored\.session\)\.map\(\(chunk\) => chunk\.sequence\)\);/);
  assert.match(store, /const physical = await this\.physicalChunkSizes\(id\);/);
  assert.match(store, /for \(const sequence of physical\.keys\(\)\) sequences\.add\(sequence\);/);
  assert.match(store, /for \(let sequence = 0; sequence <= maximum; sequence \+= 1\)/);
  assert.match(store, /if \(!sequences\.has\(sequence\)\) \{ missing\.push\(sequence\); continue; \}/);
  assert.match(store, /const bytes = await this\.readSegment\(id, sequence\);/);
  assert.match(store, /missing\.push\(sequence\)/);
  assert.doesNotMatch(store, /parts\.push\(await fs\.promises\.readFile\(/);
  // F2 — and "unreadable" is not one errno. `readSegment` reported only ENOENT
  // as missing and rethrew the rest, so a saved chunk at mode 000 (EACCES) or a
  // directory in its place (EISDIR) still took the whole recording down. The
  // behaviour is asserted for real in `meetingCapture.test.ts`; what is asserted
  // here is that the CHUNK reader does not inspect an errno, because the moment
  // it does this draws a line between two kinds of unreadable again. Recovery's
  // record-file classifier legitimately distinguishes ENOENT from an existing
  // corrupt record — that is a deletion boundary, not playback behavior.
  assert.match(chunkReader, /catch \{\s*return null;\s*\}/);
  assert.doesNotMatch(chunkReader, /ErrnoException|\bcode === '/);
  // Carried across the bridge and rendered, because a player that is short of
  // the recording and says nothing is the silent loss in a smaller costume.
  assert.match(ops, /missing: readonly number\[\]/);
  assert.match(view, /missing: audio\.missing\.length/);
  assert.match(view, /could not be read back/);
  // Nothing readable at all is not a player with a caption under it.
  assert.match(view, /if \(!audio\.bytes\.byteLength\)/);
});

test('the capture channels exist on both sides of the Electron boundary', () => {
  const main = read('../../electron/main.ts');
  const bridge = read('../../electron/meetingCaptureBridge.ts');
  const channels = read('../../electron/meetingCaptureChannels.ts');
  const preload = read('../../electron/preload.cts');
  const declarations = read('../bridge.d.ts');

  // Registered in main, which outlives a renderer crash — that is the whole
  // reason the write does not happen in the renderer.
  assert.match(main, /registerMeetingCaptureBridge\(\)/);
  // `captureWriting` and `captureRelease` were the two this list used to leave
  // out, and they are D6's whole surface: what a second window is told, and how
  // a window that is going away says so.
  for (const channel of ['captureBegin', 'captureAppend', 'captureStop', 'captureRead', 'captureFinalize', 'captureDiscard', 'captureResumable', 'captureWriting', 'captureRelease']) {
    assert.match(channels, new RegExp(`host\\.handle\\('meetings:${channel}'`), `main handles meetings:${channel}`);
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('meetings:${channel}'`), `preload invokes meetings:${channel}`);
  }
  for (const channel of ['captureBegin', 'captureAppend', 'captureStop', 'captureRead', 'captureFinalize', 'captureDiscard', 'captureResumable', 'captureWriting']) {
    assert.match(declarations, new RegExp(`${channel}\\?\\(`), `bridge.d.ts declares ${channel}`);
  }
  // D6 — `captureRelease` is the preload's own, sent when the PAGE goes away
  // rather than when the renderer asks for it, so it is not on the declared
  // surface: a component that could call it could hand away a recording that is
  // still running.
  assert.match(preload, /window\.addEventListener\('pagehide'/);
  assert.doesNotMatch(declarations, /captureRelease/);
  // …and the push that says the answer changed, which is what replaced waiting
  // out a staleness window.
  assert.match(preload, /ipcRenderer\.on\('meetings:capture-writers'/);
  assert.match(declarations, /onCaptureWriters\?\(/);

  // D2/D6 — the boot pass runs at registration, before any window can Record,
  // and is handed the one liveness answer this host has.
  assert.match(channels, /store\.recoverInterrupted\(\{/);
  assert.match(channels, /isWriting: \(id\) => supervisor\.isWriting\(id\)/);
});

test('captured audio is written 0700/0600 under the existing app-data root', () => {
  const store = read('../../electron/meetingCapture.ts');
  const bridge = read('../../electron/meetingCaptureBridge.ts');

  // D6 — the modes are the point, and mkdir/open honour the umask, so both are
  // set explicitly at creation and again afterwards.
  assert.match(store, /DIRECTORY_MODE = 0o700/);
  assert.match(store, /FILE_MODE = 0o600/);
  assert.match(store, /mkdir\(directory, \{ mode: DIRECTORY_MODE \}\)/);
  assert.match(store, /chmodQuiet\(directory, DIRECTORY_MODE\)/);
  assert.match(store, /O_EXCL/);
  assert.match(store, /O_NOFOLLOW/);

  // Open question 2 — an existing rooted location, not a new one.
  assert.match(bridge, /app\.getPath\('userData'\)/);

  // D1 — the record carries what the disk TOOK. `write` resolves rather than
  // throwing on a short write at the ENOSPC boundary, so the count is checked
  // and returned instead of the length that was intended. Where it is then
  // recorded is asserted against the supervisor, which owns the record now.
  assert.match(store, /const \{ bytesWritten \} = await handle\.write\(bytes\)/);
  assert.match(store, /return bytesWritten;/);
});

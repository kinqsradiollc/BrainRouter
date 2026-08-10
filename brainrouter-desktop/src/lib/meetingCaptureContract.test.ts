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
  assert.match(recorder, /recorder\.start\(this\.segmentMs\)/);
  assert.match(recorder, /segmentMs = options\.segmentMs \?\? DEFAULT_MEETING_SEGMENT_MS/);

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
  const startAt = recorder.indexOf('recorder.start(this.segmentMs)');
  assert.ok(beginAt > 0 && startAt > beginAt);

  // The renderer holds no filesystem path and no audio buffer: its only route to
  // durability is the bridge, and it refuses to record when that route is absent.
  assert.match(ops, /captureAppend!\(id, bytes, durationMs\)/);
  assert.match(view, /if \(!capture\.available\)/);

  // D2 — the offer is queried where the user lands after a crash (the library),
  // not only inside a compose form they would have to think to open.
  assert.match(view, /capture\.resumable\(\{ orgId: scopedOrgId \?\? null \}\)/);
  assert.match(view, /capture\.resumable\(captureScope\)/);
  // ADR-028 — and a recovery query that FAILED does not render as "nothing to
  // recover". A swallowed rejection here loses this ADR's whole deliverable
  // silently, on exactly the launch where the user is looking for it.
  assert.doesNotMatch(view, /resumable\([^)]*\)[\s\S]{0,220}catch\(\(\) => undefined\)/);
  // D6 — nor is a failed release of the audio swallowed: the session would stay
  // non-terminal and the next launch would call a meeting that SUCCEEDED an
  // interrupted recording.
  assert.doesNotMatch(view, /capture\.finalize\([^)]*\)\.catch\(/);
  assert.match(view, /onAudioRetained\(\{ sessionId: captured/);
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
  assert.match(view, /const playCapture = useCallback\(async \(sessionId: string\)[\s\S]{0,240}await capture\.read\(sessionId\)/);
  // …and the object URL is a handle on a whole recording held in this window's
  // heap, so it is released rather than leaked — §1's defect in miniature.
  assert.match(view, /URL\.revokeObjectURL\(preview\.url\)/);

  // Open question 3 — the queue is HOST-owned. A renderer that constructed one
  // would lose it on the next reload, which is the defect this ADR is about.
  assert.doesNotMatch(view, /createMeetingTranscriptionQueue/);
  assert.doesNotMatch(ops, /createMeetingTranscriptionQueue/);
});

test('the transcription queue lives in main and pushes every persisted change', () => {
  const bridge = read('../../electron/meetingCaptureBridge.ts');
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
    assert.match(bridge, new RegExp(`ipcMain\\.handle\\('meetings:${channel}'`), `main handles meetings:${channel}`);
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('meetings:${channel}'`), `preload invokes meetings:${channel}`);
    assert.match(declarations, new RegExp(`${channel}\\?\\(`), `bridge.d.ts declares ${channel}`);
  }
  // D4 — progress is pushed, not polled, and only after the write.
  assert.match(bridge, /webContents\.send\(MEETING_CAPTURE_PROGRESS_CHANNEL/);
  assert.match(preload, /ipcRenderer\.on\('meetings:capture-progress'/);
  const persistAt = supervisor.indexOf('await this.#store.persist(next)');
  const publishAt = supervisor.indexOf('this.#publish({ sessionId: id, session: next })');
  assert.ok(persistAt > 0 && publishAt > persistAt);
});

test('D1 still holds through the supervisor: bytes first, then the count the disk took', () => {
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
  const writeAt = supervisor.indexOf('await this.#store.writeSegment(id, index, bytes)');
  const recordAt = supervisor.indexOf('appendSegment(current, { byteLength: written');
  assert.ok(writeAt > 0 && recordAt > writeAt);
});

test('live text distinguishes provisional from settled, and a gap says where it is', () => {
  const view = read('../components/meetings/MeetingsView.tsx');
  const fold = read('../components/meetings/liveTranscript.ts');

  // D4 — the box is APPENDED to, never re-rendered from the session. A
  // `setTranscript(transcriptText(session))` anywhere here would compile, look
  // right, and delete a correction the user made twenty seconds earlier.
  assert.match(view, /foldTranscript\(transcriptRef\.current, session, foldRef\.current\)/);
  assert.doesNotMatch(view, /setTranscript\(transcriptText\(/);
  // D4 — and the three states are rendered as three different things.
  assert.match(view, /entry\.state === "transcribing" \? "Transcribing…" : "Queued"/);
  assert.match(view, /transcriptSoFar\(session\)/);

  // D5 — the gap wording and its time range come from the shared transcript
  // module, so a desktop transcript says what a dashboard one says.
  assert.match(fold, /formatCaptureGap\(entry\.startMs, entry\.endMs\)/);
  assert.match(fold, /planTranscription\(session\)\.exhausted/);
  assert.match(view, /onRetry\(entry\.index\)/);
});

test('a recovered capture is folded in once, through the shared reconciliation', () => {
  const view = read('../components/meetings/MeetingsView.tsx');

  // The fatal defect this guards: a restored draft ALREADY holds the capture's
  // settled segments, so resetting the fold to empty before adopting appended
  // every one of them a second time — and the doubled text is what was POSTed
  // and summarized. The rule is shared with the dashboard, which had the same
  // bug in its own dialect (D1b).
  assert.match(view, /reconcileCaptureDraft\(transcriptRef\.current, session\)/);
  assert.match(view, /foldRef\.current = \{ inserted: reconciled\.matched, next: reconciled\.next \}/);
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
  const bridge = read('../../electron/meetingCaptureBridge.ts');
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
  assert.match(view, /migrateLegacyDraft\(capture\)/);
  // …and no fallback to it from the adapter either, which is where a "the host
  // is unavailable" branch would be tempting. (Naming the store in a comment is
  // how that branch is argued against, so only a CALL is refused here.)
  assert.doesNotMatch(ops, /localStorage\.\w/);

  for (const channel of ['draftRead', 'draftWrite', 'draftClear']) {
    assert.match(bridge, new RegExp(`ipcMain\\.handle\\('meetings:${channel}'`), `main handles meetings:${channel}`);
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

test('open question 5 — a meeting is filed under the org the RECORDING started in', () => {
  const view = read('../components/meetings/MeetingsView.tsx');

  // "A recording that started under one org must not silently land in another."
  // The active org comes from the app-wide switcher and can move mid-meeting;
  // the capture's scope is frozen at Record and nothing rewrites it.
  assert.match(view, /const filedOrgId = session \? session\.scope\.orgId \?\? undefined : orgId;/);
  assert.match(view, /ops\.createFromTranscript\(\{[^}]*\}, filedOrgId\)/);
});

test('Create cannot delete a recording out from under itself', () => {
  const view = read('../components/meetings/MeetingsView.tsx');

  // The guard is not defensive tidiness. D4 fills the transcript box live, so a
  // RUNNING meeting satisfies every other condition on this button within twenty
  // seconds — and `submit` finalizes the capture, which under D6 removes the
  // directory the recorder is still appending to. The next chunk then fails with
  // "no longer on this device", the microphone stays open, and the surface goes
  // on offering "Stop recording" for a capture that no longer exists.
  assert.match(view, /disabled=\{!title\.trim\(\) \|\| !transcript\.trim\(\) \|\| Boolean\(busy\) \|\| recording\}/);
  // Guarded in the function as well as on the button: a disabled attribute is a
  // statement about a pixel, not a rule, and this is the destructive path.
  assert.match(view, /if \(!title\.trim\(\) \|\| !transcript\.trim\(\) \|\| busy \|\| recording\) return;/);
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
  assert.match(view, /\{composing \|\| recording \? \(/);
  assert.match(view, /display: composeVisible \? "contents" : "none"/);
  assert.match(view, /const composeVisible = composing && mode === "meetings";/);
  assert.match(view, /\{mode === "meetings" \|\| recording \? \(/);
  assert.match(view, /onRecordingChange=\{setRecording\}/);
  assert.match(view, /useEffect\(\(\) => \{ onRecordingChange\(recording\); \}/);
  // The indicator, and the way back. It is rendered before the tab switch so it
  // survives the two tabs that replace everything below it.
  const barAt = view.indexOf('recording && !composeVisible ?');
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
  assert.match(view, /mountedRef\.current = false;\s*\n\s*const recorder = recorderRef\.current;\s*\n\s*recorderRef\.current = null;\s*\n\s*void recorder\?\.stop\(\);/);
});

test('B — one unreadable segment is stated, not thrown at the whole recording', () => {
  const view = read('../components/meetings/MeetingsView.tsx');
  const store = read('../../electron/meetingCapture.ts');
  const ops = read('../components/meetings/captureOps.ts');

  // §6 judges this on the audio being "on disk AND playable". A `readFile` per
  // claimed segment with no guard meant one missing file rejected the whole
  // concatenation: fifty-nine other minutes on disk and unreachable, with the
  // recovery card still advertising their byte count and the user shown an
  // errno. The per-segment reader already draws this line for transcription.
  assert.match(store, /const bytes = await this\.readSegment\(id, segment\.index\);/);
  assert.match(store, /if \(!bytes\) \{ missing\.push\(segment\.index\); continue; \}/);
  assert.doesNotMatch(store, /parts\.push\(await fs\.promises\.readFile\(/);
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
  const preload = read('../../electron/preload.cts');
  const declarations = read('../bridge.d.ts');

  // Registered in main, which outlives a renderer crash — that is the whole
  // reason the write does not happen in the renderer.
  assert.match(main, /registerMeetingCaptureBridge\(\)/);
  for (const channel of ['captureBegin', 'captureAppend', 'captureStop', 'captureRead', 'captureFinalize', 'captureDiscard', 'captureResumable']) {
    assert.match(bridge, new RegExp(`ipcMain\\.handle\\('meetings:${channel}'`), `main handles meetings:${channel}`);
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('meetings:${channel}'`), `preload invokes meetings:${channel}`);
    assert.match(declarations, new RegExp(`${channel}\\?\\(`), `bridge.d.ts declares ${channel}`);
  }

  // D2/D6 — the boot pass runs at registration, before any window can Record.
  assert.match(bridge, /store\.recoverInterrupted\(\)/);
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

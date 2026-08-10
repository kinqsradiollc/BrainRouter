/**
 * ADR-035 — a wiring test for the dashboard's capture surface, because every
 * defect it guards typechecks.
 *
 * `app/meetings/page.tsx` had no test file at all, and that is a structural
 * fact rather than an oversight: every dashboard defect this ADR has had to
 * repair lived in it — the submit path, the recovery offer, the error slots,
 * the scope. The desktop's equivalent wiring is pinned line by line by
 * `brainrouter-desktop/src/lib/meetingCaptureContract.test.ts`, which is exactly
 * why the desktop stopped drifting. This is the same instrument for the same
 * reason.
 *
 * What it asserts is not "does this function work" — the pure rules are tested
 * where they live, in `lib/meetings/*.test.ts` and in the shared model. It is
 * that the pieces are CONNECTED in the one arrangement where a meeting is not
 * lost: a chunk written before it is recorded, a session transition that goes
 * through the single writer, a destructive path guarded in the function and not
 * only on the button, and a durability warning that renders where a person can
 * read it.
 *
 * Asserted against source text on purpose. A React render test cannot reach the
 * windows these defects live in — the two awaits between installing the queue
 * and `setRecording(true)`, or a chunk write failing while the dialog is closed
 * — and a defect nothing can reach is a defect that comes back.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const page = read("./page.tsx");
const live = read("./LiveTranscript.tsx");
const store = read("../../lib/meetings/captureStore.ts");

/** Where `needle` sits in the page, asserted present so an ordering check cannot pass on -1. */
function at(source: string, needle: string): number {
  const index = source.indexOf(needle);
  assert.ok(index > 0, `expected to find ${JSON.stringify(needle)}`);
  return index;
}

/**
 * The page's EXECUTABLE lines, trimmed.
 *
 * Every comment in that file names the defect it prevents, in the defect's own
 * vocabulary — so "this identifier appears nowhere" asked over the raw text is
 * answered by the paragraph explaining why it appears nowhere. Only the leading
 * marker is stripped, which is enough because the block comments this file
 * searches are all `*`-continued.
 */
function codeLines(source: string): readonly string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"));
}

test("D1/D1b — audio becomes bytes on a cadence, and nothing accumulates in the tab", () => {
  // Without an explicit timeslice `MediaRecorder` may deliver one blob at the
  // end, and the durable write buys nothing.
  assert.match(page, /rec\.start\(MEETING_CAPTURE_TIMESLICE_MS\)/);
  // The chunk goes to the store before it becomes anything else, and the segment
  // record carries what the store actually took.
  assert.match(page, /chunk = await capture\.store\.appendChunk\(capture\.sessionId, data\)/);
  assert.match(page, /appendSegment\(session, \{ byteLength: chunk\.byteLength, durationMs \}\)/);
  assert.ok(
    at(page, "chunk = await capture.store.appendChunk(capture.sessionId, data)")
      < at(page, "appendSegment(session, { byteLength: chunk.byteLength, durationMs })"),
    "the bytes are written before the segment claims they exist",
  );
  // §1's defect by name: an array of chunks in the renderer's heap.
  assert.doesNotMatch(page, /chunksRef|Blob\[\]/);

  // D2 — the session exists before the recorder does, so a crash has somewhere
  // to be found again.
  assert.ok(at(page, "await store.begin({ sessionId })") < at(page, "rec.start(MEETING_CAPTURE_TIMESLICE_MS)"));
});

test("every session transition goes through the queue, which is the single writer", () => {
  // Two writers would interleave a `markDone` with an `appendSegment` and lose
  // one of them — the same class of defect as losing the audio, just quieter.
  for (const transition of ["appendSegment(", "stopCapture(", "finalizeCapture(", "discardCaptureSession("]) {
    const calls = [...page.matchAll(new RegExp(transition.replace("(", "\\("), "g"))];
    assert.ok(calls.length > 0, `${transition} is still applied somewhere`);
    for (const call of calls) {
      // Generous, because the transitions that matter most carry the longest
      // comments: `persistChunk`'s index check explains itself at length inside
      // the `apply` callback it guards.
      const before = page.slice(Math.max(0, (call.index ?? 0) - 900), call.index);
      assert.ok(before.includes("queue.apply("), `${transition} runs inside queue.apply`);
    }
  }
});

test("FATAL 1 — what is POSTED is the settled text, with nothing in between to go stale", () => {
  // `transcriptText` keeps only settled segments and stated gaps, so a
  // provisional one contributes NOTHING: posted as-is, the sentences either side
  // of it read as contiguous speech and the audio is deleted on the next line.
  //
  // This assertion is the one that has to bind on the VALUE. Its predecessor
  // checked that `settleTranscriptForSubmit(...)` was called and ordered and
  // that the body said `transcript`, and a verifier deleted the single line
  // `transcript = settled.text;` — restoring the defect verbatim, since `let
  // transcript = draftTranscript` survived — and all ten tests still passed,
  // because every one of those three facts was still true of the broken
  // program. There is no line to delete now: the posted field IS the settle
  // result, and the shared `settleTranscriptForSubmit` takes a nullable session
  // so the pasted-transcript case is this same call rather than a branch.
  //
  // The THIRD argument is asserted as hard as the first two. Handing it a fresh
  // `EMPTY_TRANSCRIPT_FOLD` typechecks, keeps every ordering fact true, and
  // makes the settle walk from segment zero over a box that already holds the
  // meeting — so the doubled transcript is what gets POSTed and summarized.
  const settle = at(page, "settleTranscriptForSubmit(draftTranscript, queue?.session ?? null, foldRef.current)");
  const post = at(page, 'await authFetch<{ id: string }>("/api/meetings"');
  const release = at(page, "await releaseCapture(true)");
  assert.ok(settle < post, "the text is settled before it is posted");
  assert.ok(post < release, "and the audio is only released once the meeting exists on the server");
  assert.match(page, /body: \{ title: draftTitle\.trim\(\), transcript: submitted\.text, template: summaryTemplate \}/);
  // The box is shown what was posted in the same breath. A create that FAILS
  // leaves the person looking at their transcript again, and a box that does
  // not hold the gap markers the server was just sent — while the fold says it
  // does — is a surface disagreeing with the record about what is in the
  // meeting, which is the class of thing this ADR exists to stop.
  assert.match(page, /if \(submitted\.changed\) setDraftTranscript\(submitted\.text\);/);
  // The box's own state is never what is posted: it has not re-rendered yet at
  // this point in the function, so it is the pre-settle text by definition.
  assert.doesNotMatch(page, /body: \{ title: draftTitle\.trim\(\), transcript: draftTranscript/);
  assert.doesNotMatch(page, /let transcript = draftTranscript/);

  // ADR-028 — and it is said BEFORE the click, not discovered afterwards.
  assert.match(page, /unsettledSegments\(captureSession\)\.length/);
  assert.match(page, /segments are still being transcribed/);
});

test("FATAL 2 — the destructive path is guarded in the function, not only on the button", () => {
  // `recording` is false for the whole stretch between the queue being installed
  // and the recorder starting, and Create landing there finalized and DELETED a
  // session the recorder then wrote chunks into.
  assert.match(page, /const captureInFlight = recording \|\| armingRef\.current \|\| captureRef\.current !== null;/);
  assert.match(page, /if \(captureInFlight \|\| busy\) \{/);
  assert.match(page, /armingRef\.current = true;/);
  // Raised once, and lowered on every way out of `startRecording`: the store
  // failing to open, the recorder failing to start, and the happy path.
  assert.equal(page.match(/armingRef\.current = true;/g)?.length, 1);
  assert.equal(page.match(/armingRef\.current = false;/g)?.length, 3);
  // The button still says it too — this is belt as well as braces.
  assert.match(page, /onClick=\{\(\) => void submitCreate\(\)\} disabled=\{busy === "create" \|\| recording \|\| settlingCapture\}/);
});

test("A — the create guard outlives Stop, and covers the window the last chunk lands in", () => {
  // `finishCapture` used to null `captureRef` on its first line, BEFORE
  // `settled()` and before the `stopCapture` transition. `stopRecording` has
  // already set `recording` false and `armingRef` is down, so across that window
  // every term of the guard was false, "Create + summarize" was enabled in the
  // same row of the same dialog, and clicking it posted a transcript missing its
  // final chunk with no gap marker — then deleted that chunk's audio.
  const finish = at(page, "const finishCapture = useCallback(async (capture: ActiveCapture) => {");
  const next = at(page, "const startRecording = useCallback(async () => {");
  const body = page.slice(finish, next);
  const settled = body.indexOf("await capture.store.settled(capture.sessionId)");
  const stopped = body.indexOf("stopCapture(session)");
  const released = body.indexOf("captureRef.current = null");
  assert.ok(settled > 0 && stopped > 0 && released > 0, "all three steps are still here");
  assert.ok(released > settled, "the guard outlives the store's write queue draining");
  assert.ok(released > stopped, "and outlives the stop transition landing in the session");
  // Released in the `finally`, identity-checked: a settle that THREW must not
  // wedge Create for good, and a new recording started meanwhile must keep its
  // own guard.
  assert.match(body, /if \(captureRef\.current === capture\) captureRef\.current = null;/);
  // …and the surface says so rather than offering a button it will refuse.
  assert.match(page, /setSettlingCapture\(true\)/);
  assert.match(page, /The end of this recording is still being written to this device/);
});

test("C — a recording that never started leaves nothing behind to wedge Create", () => {
  // `captureRef` is set before `attachQueue` (which reads `getJwt()` and throws
  // on a partitioned localStorage) and before `rec.start(...)` (which throws
  // NotSupportedError when the stream went inactive). Leaked, it makes every
  // later submit refuse while `recording` is false and the button says "Record":
  // there is nothing to stop, and only a reload clears it.
  const start = at(page, "const startRecording = useCallback(async () => {");
  const body = page.slice(start, at(page, "const pickUpCapture = useCallback"));
  assert.match(body, /if \(captureRef\.current\?\.sessionId === sessionId\) captureRef\.current = null;/);
  // The failure path also releases the microphone: `onstop` is what stops the
  // tracks, and it never fires for a recorder that would not start.
  assert.match(body, /stream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\);/);
});

test("D — the sticky slot reports the failure that happened, not the worst one", () => {
  // One `try` covered `appendChunk`, the `queue.apply` that records the segment
  // and `budget()`, and its single catch asserted the audio was gone for all
  // three. Only the first loses audio.
  const persist = at(page, "const persistChunk = useCallback(async (capture: ActiveCapture, data: Blob) => {");
  const body = page.slice(persist, at(page, "const finishCapture = useCallback"));
  // The lost-audio sentence belongs to the chunk write and nothing else.
  const lost = "That audio is missing from the meeting, and no segment was recorded for it";
  assert.equal(body.split(lost).length - 1, 1, "said once");
  const append = body.indexOf("await capture.store.appendChunk(capture.sessionId, data)");
  const apply = body.indexOf("await queue.apply(");
  assert.ok(append > 0 && apply > append);
  assert.ok(body.indexOf(lost) > append && body.indexOf(lost) < apply, "and only for the chunk write");
  // A segment that could not be recorded leaves the audio written and
  // unclaimed, which is the safe failure the transition is designed around.
  assert.match(body, /The audio itself IS saved; that piece is left unclaimed/);
  // A budget reading that could not be taken lost nothing, and says nothing.
  const budget = body.indexOf("await capture.store.budget({");
  assert.ok(budget > apply, "the budget is read after the segment is recorded");
  assert.doesNotMatch(body.slice(budget), /setCaptureWarning\(/);
});

test("FATAL 3 — a chunk that could not be written reports into the STICKY slot", () => {
  // `createErr` renders only inside the compose dialog, which the × and the
  // scrim close WITHOUT stopping the recording; and `submitCreate` opens by
  // clearing it, so the one sentence saying part of the recording was never
  // written was erased at the moment the user committed and the audio was
  // deleted.
  assert.match(page, /setCaptureWarning\(`A piece of this recording could not be saved on this device/);
  const failure = at(page, "A piece of this recording could not be saved on this device");
  const routed = page.slice(Math.max(0, failure - 200), failure);
  assert.doesNotMatch(routed, /setCreateErr\(/);
  // Both capture slots follow the user out of the dialog.
  assert.match(page, /\{!createOpen && captureWarning \?/);
  assert.match(page, /\{!createOpen && captureNotice \?/);
  // …and a recording with no dialog on screen is not a silent open microphone.
  assert.match(page, /\{!createOpen && recording \?/);
  // The one place that clears it is a NEW recording, where the last one's
  // warnings genuinely stop being true.
  assert.equal(page.match(/setCaptureWarning\(""\)/g)?.length, 2);
});

test("a recovered capture is folded in once, and its own language is used", () => {
  // The doubling defect, and the reason this test is written as an exhaustive
  // list rather than as three `assert.match`es.
  //
  // Its predecessor asserted `included: reconciled.accounted` and the `dirty:`
  // line but never the `base:` field, so respelling `base: reconciled.retained`
  // as `base: options.base` restored §6's doubled meeting verbatim with all 123
  // tests green. The lesson is that pinning SOME of the fields that reach
  // composition pins none of it. What reaches composition now is one value —
  // the fold — so every write to it is enumerated: a `beginTranscriptFold`
  // swapped for `EMPTY_TRANSCRIPT_FOLD` (the doubling), a `folded.fold` that is
  // computed and dropped (the "call present, result unused" shape), a
  // `submitted.fold` that never lands, and any FOURTH writer that appears
  // beside them all fail here.
  const foldWrites = codeLines(page).filter((line) => line.startsWith("foldRef.current ="));
  assert.deepEqual(foldWrites, [
    // Resume over the restored box rather than at segment zero — §6.
    "foldRef.current = beginTranscriptFold(reconciled);",
    // The drain's fold, kept, or the next one appends the same run again.
    "foldRef.current = folded.fold;",
    // Submit's settle, kept, or a create that failed leaves the fold behind the
    // box and the gap markers it just wrote are appended a second time.
    "foldRef.current = submitted.fold;",
  ]);
  // The resume point is built from the reconcile of the RESTORED BOX, and it is
  // the only thing built from it: `reconciled.retained` — the box with every
  // segment stripped out of it — is what the recompose model used as its base,
  // and it must never reach composition again on this host.
  assert.match(page, /const reconciled = reconcileCaptureDraft\(options\.base, session\);/);
  assert.doesNotMatch(page, /reconciled\.retained/);
  // The empty fold has exactly one honest use on this page — the ref's initial
  // value, for a box no capture has ever written into.
  assert.deepEqual(
    codeLines(page).filter((line) => line.includes("EMPTY_TRANSCRIPT_FOLD")),
    ["EMPTY_TRANSCRIPT_FOLD,", "const foldRef = useRef<TranscriptFold>(EMPTY_TRANSCRIPT_FOLD);"],
  );
  // …and the fold is seeded before the session that triggers the fold effect is
  // published, so there is no render in which the box is folded from zero.
  const attach = at(page, "const attachQueue = useCallback(");
  const seed = page.indexOf("foldRef.current = beginTranscriptFold(reconciled);", attach);
  const publish = page.indexOf("setCaptureSession(session);", attach);
  assert.ok(seed > attach && publish > seed, "the resume point is set before the session is published");
  // Reconciliation still heals a stated gap in place on the way in, and the box
  // is only rewritten when it actually changed.
  assert.match(page, /if \(reconciled\.text !== options\.base\) setDraftTranscript\(reconciled\.text\);/);
  // A meeting recorded in Japanese was recorded in Japanese, whatever the page's
  // dropdown has since been reset to.
  assert.match(page, /session\.language \?\? \(language === "auto" \? undefined : language\)/);
});

test("A — composition is the shared append-only fold, and the recompose model is gone", () => {
  // The last data-corruption defect on this host, and its one cause: the page
  // rebuilt `base + transcriptText(session)` on every drain with `base` set to
  // the box MINUS every segment. That puts all of a person's own words first
  // and the whole meeting after them, so across a kill a note typed BETWEEN two
  // segments came back above the entire transcript and an edit to the last
  // settled segment came back reverted AND relocated to the top — both then
  // autosaved, POSTed and summarized.
  //
  // The fold is asserted as a whole line each, because each carries a value the
  // ordering and the presence of the call say nothing about.
  assert.match(page, /const folded = foldTranscript\(draftTranscript, captureSession, foldRef\.current\);/);
  assert.match(page, /if \(!folded\.changed\) return;/);
  assert.match(page, /setDraftTranscript\(folded\.text\);/);
  // The second host's answer, gone rather than merely unused — including the
  // module it lived in.
  const code = codeLines(page).join("\n");
  for (const dead of [
    "transcriptSync",
    "nextTranscriptSync",
    "appendTranscriptSync",
    "composeCaptureTranscript",
    "healTranscriptGaps",
    "pendingTranscriptText",
    "includedTranscriptIndices",
    "transcriptRevisionPending",
    "transcriptText(",
  ]) {
    assert.equal(code.includes(dead), false, `${dead} is gone from the page`);
  }
  assert.throws(() => read("../../lib/meetings/transcriptSync.ts"), "the second composition rule is deleted, not orphaned");

  // The `dirty` flag goes with it, and is NOT reconstructed. It was a keystroke
  // — runtime state that dies with the tab — and the page recomputed it after a
  // reload as `reconciled.userOwned.length > 0`, which is `[]` whenever every
  // segment still matches the box verbatim. A note typed BETWEEN two segments
  // leaves every segment matching, so it came back `false`, recomposition
  // switched itself back ON across the very kill it was protecting the box
  // from, and the note was relocated above the whole transcript. There is no
  // better formula: "a person has taken ownership of the ordering" is not
  // derivable from the box plus the session. An append-only fold needs no such
  // fact, which is why the resume point is a fold — a thing that IS
  // reconstructible, by `beginTranscriptFold` above.
  assert.doesNotMatch(page, /dirty:|\.dirty\b|dirtyRef/);
  // Under append-only composition no text is ever withheld from the box, so the
  // affordance that offered it back has nothing left to offer.
  assert.doesNotMatch(page, /Bring the transcript up to date/);
  assert.doesNotMatch(page, /appendCaptureText|captureRevisionPending/);
});

test("E/D6 — the draft is the protected store's, and it is the WHOLE compose box", () => {
  assert.doesNotMatch(page, /localStorage\.setItem/);
  assert.doesNotMatch(page, /brainrouter:meeting-draft/);
  // Read once and removed, because a copy left behind is not a move.
  assert.match(page, /takeLegacyMeetingDraft\(localStorage\)/);
  // What is persisted is the box, not the box minus what the session can account
  // for. `retained` is a stripped COMPLEMENT: reopening reconciles it against
  // the same session a second time, and the four corruptions that follow are
  // all silent — a retained line matching a segment pins the frontier and loses
  // the rest of the meeting with no gap marker, an edit comes back doubled, a
  // deletion returns, a note is relocated.
  //
  // It is also what makes the fold's resume point reconstructible at all: the
  // box that comes back holds this capture's segments verbatim, so
  // `reconcileCaptureDraft` can say which ones and where. A stripped box has
  // had exactly that evidence removed from it.
  assert.match(page, /await writeMeetingDraft\(store, \{ title: draftTitle, transcript: draftTranscript, language, template: summaryTemplate \}\)/);
  assert.doesNotMatch(page, /reconcileCaptureDraft\(draftTranscript, captureSession\)/);
  // …and because a strip cannot be detected on the way back in, the type says so
  // too: a host that reintroduced it would be contradicting the field's contract.
  assert.match(read("../../lib/meetings/meetingDraft.ts"), /never `MeetingDraftReconciliation\.retained`/);

  // The one reconcile that stays is the READ side: the fold's resume point over
  // a restored draft meeting a recovered capture, which is never written down.
  const attach = at(page, "const attachQueue = useCallback(");
  const reconcile = at(page, "const reconciled = reconcileCaptureDraft(options.base, session)");
  assert.ok(reconcile > attach && reconcile < at(page, "const revokePreview = useCallback("));
  const reconcileCalls = page
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("*") && !line.startsWith("//") && line.includes("reconcileCaptureDraft("));
  assert.deepEqual(reconcileCalls, ["const reconciled = reconcileCaptureDraft(options.base, session);"], "reconciled once, on the way in");
});

test("F — the wake floor and the phase sentence are the shared ones", () => {
  // The two hosts did NOT agree, which is the strongest available argument for
  // the export. This page floored the queue's own `nextWakeMs` with an inline
  // `Math.max(500, result.nextWakeMs)` and the desktop's supervisor with a
  // private `MIN_WAKE_MS = 250`, so the same schedule probed a struggling
  // sidecar at two different rates depending on which host you were on.
  // Adopting the shared 500 halves the desktop's: two attempts a second rather
  // than the four it was making. There was never a `MEETING_DRAIN_FLOOR_MS`
  // anywhere — the number was a literal in this file, which is why nothing was
  // ever going to notice the two drifting.
  //
  // The null check folds into the helper, because "nothing to schedule" and
  // "not before the floor" are the same question about the same answer.
  assert.match(page, /const delay = drainWakeDelayMs\(result\.nextWakeMs\);/);
  assert.match(page, /if \(delay !== null\) \{/);
  // …and the floored value is what ARMS the timer. Calling the helper and then
  // arming on the raw `result.nextWakeMs` keeps every assertion above true and
  // puts the unfloored schedule straight back — the "call present, result
  // unused" shape, which is the one that has survived a mutation round before.
  assert.match(page, /\}, delay\);/);
  assert.deepEqual(
    codeLines(page).filter((line) => line.includes("result.nextWakeMs")),
    ["const delay = drainWakeDelayMs(result.nextWakeMs);"],
    "the queue's raw schedule is read once, by the floor, and nowhere else",
  );
  // …and the live panel's sentence comes from the shared module, not a local
  // copy of it. The dashboard's copy is deleted, not merely unused.
  assert.match(live, /capturePhaseNote,/);
  assert.doesNotMatch(live, /from "\.\.\/\.\.\/lib\/meetings\/capturePhase"/);
});

test("open question 5 — the recovery offer is scoped, and asks the shared rule", () => {
  assert.match(page, /resumableCaptures\(await store\.list\(\), \{/);
  assert.match(page, /scope: \{ orgId: activeOrgId \|\| null \}/);
  // The store cannot answer this — it treats the payload as opaque text — so the
  // predicate it used to restate is gone from it entirely.
  assert.doesNotMatch(page, /store\.resumable\(/);
  assert.doesNotMatch(store, /!record\.closed && record\.byteLength > 0/);
  assert.doesNotMatch(store, /async resumable\(|async attach\(/);
  // The other half of open question 5, which this host already had right: the
  // meeting is created under the scope frozen at Record, not the one the
  // switcher happens to be showing.
  assert.match(page, /const captureOrgId = queue\?\.session\.scope\.orgId/);
});

test("§6 — the audio that came back is playable, and its object URL is handed back", () => {
  assert.match(page, /await store\.readAudio\(record\.sessionId, mimeType \|\| DEFAULT_CAPTURE_MIME_TYPE\)/);
  assert.match(page, /URL\.revokeObjectURL\(previewRef\.current\.url\)/);
  // D6 — audio no session can claim is audio nothing can free, so every load
  // reaps it, and the reap is logged.
  assert.match(page, /await store\.reapOrphans\(active \? \{ keep: \[active\] \} : \{\}\)/);
  assert.match(page, /console\.warn\(`\[meetings\] reaped/);
  // ADR-028 — a recovery query that FAILED is not "nothing to recover".
  assert.match(page, /setRecoveryError\(`Recordings saved on this device could not be checked/);
});

test("the live panel asks the shared phase rule rather than keeping its own", () => {
  assert.match(live, /capturePhaseNote\(session, phase, \{ gaps, provisional \}\)/);
  assert.doesNotMatch(live, /function phaseNote/);
  // D4 — three states rendered as three different things.
  assert.match(live, /entry\.state === "transcribing" \? "Transcribing…" : "Queued"/);
});

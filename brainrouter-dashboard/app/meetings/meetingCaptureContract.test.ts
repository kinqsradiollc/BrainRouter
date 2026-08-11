/**
 * ADR-035 — what is left to say about the dashboard's capture surface once a
 * test can DRIVE it.
 *
 * This file used to be the only instrument `app/meetings/page.tsx` had, and it
 * asserted over source text because a 1900-line React component could not be
 * exercised in this runner at all. That was a bad trade taken knowingly, and it
 * failed in the way source assertions always fail: a `base:` field respelled and
 * §6's doubled transcript came back with every test green; a
 * `transcript = settled.text` deleted and the unmarked hole came back with every
 * test green; `meetingOrgId` respelled `activeOrgId` and nothing here could have
 * noticed at all.
 *
 * `captureSurface.ts` moved those decisions out of the component, and
 * `captureSurface.test.ts` now presses Record, hands over a chunk, leaves the
 * page and reads what reached the POST. So what remains here is only what a
 * behavioural test genuinely cannot see:
 *
 * - **that something is GONE** — a deleted module, a dead identifier, a second
 *   copy of a rule that must not grow back;
 * - **the arrangement of a render** — a warning slot that has to be outside the
 *   dialog, because the dialog can be closed while the microphone is open;
 * - **the ONE wire between React and the surface** that the surface itself
 *   cannot test: the unmount cleanup that calls `dispose()`.
 *
 * Anything that can be asserted by driving the surface belongs in the other
 * file, not here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CAPTURE_LOCKS_UNAVAILABLE } from "../../lib/meetings/captureLock";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const page = read("./page.tsx");
const surface = read("./captureSurface.ts");
const live = read("./LiveTranscript.tsx");
const store = read("../../lib/meetings/captureStore.ts");

/**
 * A file's EXECUTABLE lines, trimmed.
 *
 * Every comment in these files names the defect it prevents, in the defect's own
 * vocabulary — so "this identifier appears nowhere" asked over the raw text is
 * answered by the paragraph explaining why it appears nowhere.
 */
function codeLines(source: string): readonly string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"));
}

test("A — the page hands the recording back on unmount, which is the one wire the surface cannot test", () => {
  // `dispose()` is covered behaviourally in `captureSurface.test.ts`; what is
  // NOT reachable from there is whether React ever calls it. Without this line a
  // client-side navigation leaves the `MediaRecorder` running with the
  // microphone open while the remounted page has a fresh empty guard.
  assert.match(page, /useEffect\(\(\) => \{\s*void capture\.init\(\);\s*return \(\) => \{ void capture\.dispose\(\); \};\s*\}, \[capture\]\);/);
  // …and the surface is built ONCE, with no dependencies. Rebuilding it when the
  // org changes would drop the recording it is holding — which is the defect it
  // exists to prevent, arriving through the door meant to stop it.
  assert.match(page, /const capture = useMemo\(\(\) => \{/);
  assert.match(page, /return new MeetingCaptureSurface\(ports\);\s*\}, \[\]\);/);
  // The switcher's org reaches it through a ref for the same reason.
  assert.match(page, /activeOrgId: \(\) => activeOrgRef\.current,/);
  assert.match(page, /activeOrgRef\.current = activeOrgId;/);
  // …and the ports it is built from are `capturePorts.ts`, which is the module
  // `capturePorts.test.ts` drives. A page that built its own would be tested by
  // nothing again — and the wire that decides it is `locks`, where a
  // manager-less stand-in leaves every cross-tab guard answering "nobody is
  // writing" with the whole suite green.
  assert.match(page, /const ports = browserCapturePorts\(\{/);
  for (const inlined of ["browserCaptureLocks", "getUserMedia", "new MediaRecorder", "createSttTranscriber", "openMeetingCaptureStore"]) {
    assert.equal(page.includes(inlined), false, `${inlined} is capturePorts.ts's, not the page's`);
  }
});

test("the page keeps no second copy of the capture's state", () => {
  // The four deleted guards were all React state in one mount describing a store
  // scoped to the origin. A fifth of that shape would fail the same way, so the
  // page is not allowed to hold any of it.
  for (const revived of [
    "captureRef",
    "queueRef",
    "recorderRef",
    "armingRef",
    "foldRef",
    "setRecording(",
    "setCaptureSession(",
    "setSettlingCapture(",
    "setCaptureWarning(",
    "setDraftTranscript(",
  ]) {
    assert.equal(page.includes(revived), false, `${revived} is the surface's, not the page's`);
  }
  // §1's original defect by name: an array of chunks in the renderer's heap.
  assert.doesNotMatch(page, /chunksRef|Blob\[\]/);
  assert.doesNotMatch(surface, /chunksRef|Blob\[\]/);
});

test("playback names unreadable saved chunks, not transcription segments", () => {
  // The behavioural parity case has two unreadable chunks inside one unit. This
  // is the render half: showing "one segment" for that state would undercount
  // the physical losses and conflate the two D9 layers again.
  assert.match(page, /saved audio chunk/);
  assert.match(page, /cap\.preview\.missingChunks/);
  assert.doesNotMatch(page, /segment.*could not be read back/);
});

test("every session transition goes through the queue, which is the single writer", () => {
  // Two writers would interleave a `markDone` with a ledger append or unit seal
  // and lose one of them — the same class of defect as losing the audio, just
  // quieter.
  for (const transition of ["appendCaptureChunk(", "sealDueUnits(", "stopCapture(", "finalizeCapture(", "discardCaptureSession("]) {
    const calls = [...surface.matchAll(new RegExp(transition.replace("(", "\\("), "g"))];
    assert.ok(calls.length > 0, `${transition} is still applied somewhere`);
    for (const call of calls) {
      const before = surface.slice(Math.max(0, (call.index ?? 0) - 1400), call.index);
      assert.ok(before.includes("queue.apply("), `${transition} runs inside queue.apply`);
    }
  }
});

test("liveness is the browser's lock, and the lease is GONE rather than merely unread", () => {
  // A heartbeat that is still written is a second opinion about a fact the
  // browser states exactly — and the offer would start honouring it again the
  // moment somebody restored the read, which is how §6's headline broke. So the
  // identifiers go, on both sides of the seam.
  for (const dead of [
    "acquireCaptureLease",
    "heartbeatCaptureLease",
    "releaseCaptureLease",
    "isCaptureLeaseFresh",
    "describeCaptureWriter",
    "capturesBeingWritten",
    "MEETING_CAPTURE_HEARTBEAT_MS",
    "beatLease",
    "startHeartbeat",
    "holderId",
  ]) {
    assert.equal(codeLines(surface).some((line) => line.includes(dead)), false, `${dead} is gone from the surface`);
    assert.equal(codeLines(page).some((line) => line.includes(dead)), false, `${dead} is gone from the page`);
  }
  // There is no threshold left anywhere on this host, which is the property that
  // makes the killed-tab case answerable at once instead of eventually.
  assert.doesNotMatch(surface, /STALE_MS/);
  // The writer id had exactly one job — naming a lease holder across a reload.
  // A Web Lock is per browsing context by construction and a reload releases it,
  // so the module is deleted rather than left orphaned.
  assert.throws(() => read("../../lib/meetings/captureHolder.ts"), "the holder-id module is deleted");
  // …and the manifest has no field to put liveness back into.
  assert.equal(
    codeLines(read("../../lib/meetings/capturePayload.ts")).some((line) => line.includes("writer?: MeetingCaptureLease")),
    false,
    "the envelope carries what a meeting IS, not who was writing to it a moment ago",
  );
});

test("golden rule 23 — the browser that cannot coordinate says so, in its own slot", () => {
  // A render arrangement, which is why it is asserted here: the sentence is a
  // standing property of this browser for the whole page view, so it gets a slot
  // that no event overwrites — inside the dialog and outside it, exactly like
  // the notice it sits beside.
  assert.match(page, /\{!cap\.createOpen && cap\.coordination \? <div className=\{styles\.errorBar\} role="status">/);
  assert.match(page, /\{cap\.coordination \? <div className=\{styles\.errorBar\} role="status">/);
  assert.match(surface, /if \(!ports\.locks\.available\) this\.#state = \{ \.\.\.this\.#state, coordination: CAPTURE_LOCKS_UNAVAILABLE \};/);
  // …and the sentence names BOTH browsers it is printed to, because that line
  // raises it in the constructor and the page renders it unconditionally. It
  // said only "older versions of Safari and Firefox and in some in-app
  // browsers", which told a current-Chrome user on an insecure origin that the
  // cause was their browser's age — `LockManager` is `[SecureContext]`, so an
  // insecure page has no Web Locks whatever it is running — and it had lost the
  // one remedy that audience actually has. "You cannot record there anyway" does
  // not reach this sentence: it prints before, and independently of, any Record.
  assert.match(CAPTURE_LOCKS_UNAVAILABLE, /http from anywhere but localhost/i, "the insecure origin, which is the case a current browser hits");
  // …and it EXCLUDES the commonest plain-http page there is. `http://localhost`
  // is potentially trustworthy per Secure Contexts, so it has Web Locks, a
  // microphone and `crypto.randomUUID`, and it is the URL this dashboard is
  // developed and demoed on. The sentence used to say "plain http", which named
  // that page as uncoordinated when it is not — the same over-generalization in
  // the other direction.
  assert.equal(
    CAPTURE_LOCKS_UNAVAILABLE.split("localhost").length - 1,
    1,
    "localhost appears once, and the assertion above pins it to the exclusion",
  );
  assert.match(CAPTURE_LOCKS_UNAVAILABLE, /older versions of Safari and Firefox/i, "and the secure browsers that predate Web Locks and really can record");
  assert.match(CAPTURE_LOCKS_UNAVAILABLE, /https/i, "with the remedy the first of them has");
});

test("golden rule 23 — the offer's Discard says what this browser cannot vouch for, and still works", () => {
  // A render arrangement, and the one this page was silent about. `writer` alone
  // is not enough: on a browser with no Web Locks it is empty because nothing can
  // be KNOWN, not because nothing is being written — so the tooltip carries the
  // unknown as well, and it is the same sentence `discard` puts to the person, so
  // the button cannot promise a different one.
  assert.match(page, /const unsure = !writer && !cap\.writersKnown \? CAPTURE_DISCARD_UNKNOWN : null;/);
  // Disabled only by a writer this browser can actually name. Disabling it on the
  // unknown was a delete with no path at all on that browser: the offer's row is
  // the only place Discard is rendered, and picking the capture up to "discard it
  // here" removes the row. The function asks; the button must be pressable for
  // the question to be reachable.
  assert.match(page, /disabled=\{cap\.busy === "transcribe" \|\| Boolean\(writer\)\} title=\{writer \?\? unsure \?\? undefined\}/);
  // Pick up is deliberately NOT gated on it either — a browser that cannot
  // coordinate its tabs must still be able to recover a crashed meeting, which is
  // D1b — and `pickUp` asks the same person the same kind of question, which is
  // driven in `captureSurface.test.ts`.
  assert.match(page, /disabled=\{cap\.busy === "transcribe" \|\| cap\.capturing \|\| Boolean\(writer\)\}/);
});

test("what starts or adopts a capture reads IN HAND, and only what ends one reads LANDING", () => {
  // The wiring of a `disabled` is only visible in the source, and two defects
  // have lived in it. `recording` is false for the whole arming window — a
  // persistent-storage prompt, then a microphone prompt — and false again across
  // the settle after Stop. Widening every control to "in flight" then made them
  // all live again ONE TICK after Stop, over a box that still holds a meeting
  // nobody has filed. So the two questions are different questions: Record and
  // Pick up ask whether a capture is in this tab's hands, and Create — the press
  // that takes it out of them — asks only whether its audio has landed.
  //
  // The behavioural half (what the FUNCTIONS refuse, and what each flag says
  // across each window) is driven in `captureSurface.test.ts`.
  assert.match(page, /disabled=\{cap\.busy === "transcribe" \|\| cap\.capturing \|\| Boolean\(writer\)\}/, "Pick up");
  assert.match(page, /disabled=\{cap\.busy === "transcribe" \|\| \(!cap\.recording && cap\.capturing\)\}/, "the Record face of the record/stop button — the Stop face is never disabled");
  assert.match(page, /disabled=\{cap\.busy === "create" \|\| cap\.landing\}/, "Create, which waits for the audio and NOT for the capture to be filed");
  // The one control that files a capture the other way. Without it, in-hand is a
  // wedge: the offer excludes whatever this tab holds, so the only other Discard
  // is on a row that is never rendered for it.
  assert.match(page, /onClick=\{\(\) => void capture\.discardHeld\(\)\}>Discard recording<\/button>/);
  assert.match(page, /\{cap\.session && !cap\.landing \? \(/, "and it is offered once the audio has landed, not while a chunk is in flight");
  // …and the published copies are DERIVED from the predicates rather than kept
  // by hand beside them. Both are made of private fields, and a second
  // hand-written copy of either answer is how the four deleted guards came apart.
  assert.match(surface, /this\.#state = \{ \.\.\.this\.#state, capturing: this\.#captureInHand, landing: this\.#captureLanding \};/);
  assert.deepEqual(codeLines(surface).filter((line) => line.includes("#captureInHand")), [
    "get #captureInHand(): boolean {",
    "if (this.#captureInHand) {",
    "if (this.#captureInHand) {",
    "this.#state = { ...this.#state, capturing: this.#captureInHand, landing: this.#captureLanding };",
  ]);
  assert.deepEqual(codeLines(surface).filter((line) => line.includes("#captureLanding")), [
    "get #captureLanding(): boolean {",
    "if (this.#captureLanding) {",
    "const landing = this.#captureLanding;",
    "this.#state = { ...this.#state, capturing: this.#captureInHand, landing: this.#captureLanding };",
  ]);
  // Each predicate's facts are spelled out in ONE place. An inline second copy
  // is what this rules out: `submit` had one, and the two paths that can destroy
  // a recording — `record` and `pickUp` — had none.
  assert.deepEqual(codeLines(surface).filter((line) => line.includes("this.#queue !== null")), [
    "return this.#claiming !== \"\" || this.#queue !== null;",
  ]);
  assert.deepEqual(codeLines(surface).filter((line) => line.includes("this.#active !== null")), [
    "return this.#claiming !== \"\" || this.#state.recording || this.#active !== null;",
  ]);
  // `#queue` is the half of in-hand that says FILED, so what may drop it is
  // enumerated: `#release`, which both a create that succeeded and a discard
  // pass through, and `#abandonArming`, whose recording never existed. A third
  // one is a capture leaving this tab's hands without being filed — which is the
  // state in which Record starts a second meeting into the first one's box.
  assert.equal(codeLines(surface).filter((line) => line.includes("this.#queue = null")).length, 2);
  assert.match(surface, /async #release\(accepted: boolean\): Promise<void> \{\s*const queue = this\.#queue;\s*if \(!queue\) return;\s*this\.#queue = null;/);
  assert.match(surface, /if \(this\.#queue\?\.session\.id === sessionId\) \{\s*this\.#queue = null;/);
  // The two private facts are written through the setters that republish, and
  // nowhere else — a direct assignment would leave the buttons reading a
  // `capturing` that stopped being true.
  assert.deepEqual(codeLines(surface).filter((line) => line.includes("this.#claiming = ")), ["this.#claiming = claiming;"]);
  assert.deepEqual(codeLines(surface).filter((line) => line.includes("this.#active = ")), ["this.#active = capture;"]);
});

test("composition has ONE rule, and the recompose model is gone rather than unused", () => {
  // The last data-corruption defect on this host: the page rebuilt
  // `base + transcriptText(session)` on every drain with `base` set to the box
  // MINUS every segment, so a note typed BETWEEN two segments came back above
  // the entire transcript and an edit came back reverted AND relocated.
  //
  // The fold's writes are enumerated rather than merely present, because a
  // `beginTranscriptFold` swapped for `EMPTY_TRANSCRIPT_FOLD` is the doubling,
  // and a `folded.fold` computed and dropped is the "call present, result
  // unused" shape that has survived a mutation round before.
  assert.deepEqual(codeLines(surface).filter((line) => line.startsWith("this.#fold =")), [
    // Resume over the restored box rather than at segment zero — §6.
    "this.#fold = beginTranscriptFold(reconciled);",
    // The drain's fold, kept, or the next one appends the same run again.
    "this.#fold = folded.fold;",
    // A DISCARDED meeting starts a new box too, and for the same reason: its
    // words leave with its audio, or the next recording folds into a box that
    // still holds the meeting just thrown away.
    "this.#fold = EMPTY_TRANSCRIPT_FOLD;",
    // Submit's settle, kept, or a create that failed leaves the fold behind the
    // box and the gap markers it just wrote are appended a second time.
    "this.#fold = submitted.fold;",
    // A created meeting starts a new box, so it starts a new fold.
    "this.#fold = EMPTY_TRANSCRIPT_FOLD;",
  ]);
  // `reconciled.retained` — the box with every segment stripped out of it — is
  // what the recompose model used as its base. It must never reach composition
  // again: a stripped complement reconciled a second time loses the rest of the
  // meeting with no gap marker, doubles an edit, returns a deletion.
  assert.doesNotMatch(surface, /reconciled\.retained/);
  assert.deepEqual(
    codeLines(surface).filter((line) => line.includes("reconcileCaptureDraft(")),
    ["const reconciled = reconcileCaptureDraft(options.base, session);"],
    "reconciled once, on the way in",
  );
  const code = codeLines(surface).join("\n");
  for (const dead of [
    "transcriptSync",
    "nextTranscriptSync",
    "appendTranscriptSync",
    "composeCaptureTranscript",
    "healTranscriptGaps",
    "transcriptText(",
  ]) {
    assert.equal(code.includes(dead), false, `${dead} is gone`);
  }
  assert.throws(() => read("../../lib/meetings/transcriptSync.ts"), "the second composition rule is deleted, not orphaned");
  // The `dirty` flag goes with it and is NOT reconstructed: "a person has taken
  // ownership of the ordering" is not derivable from the box plus the session,
  // and the page's formula for it came back `false` across the very kill it was
  // protecting the box from. An append-only fold needs no such fact.
  assert.doesNotMatch(surface, /dirty:|\.dirty\b|dirtyRef/);
  assert.doesNotMatch(page, /Bring the transcript up to date/);
});

test("D6 — the draft is the protected store's, and it is the WHOLE compose box", () => {
  assert.doesNotMatch(page, /localStorage\.setItem/);
  assert.equal(codeLines(surface).some((line) => line.includes("localStorage")), false, "the surface is handed a storage; it never reaches for one");
  assert.doesNotMatch(page, /brainrouter:meeting-draft/);
  // Read once and removed, because a copy left behind is not a move.
  assert.match(surface, /takeLegacyMeetingDraft\(storage\)/);
  // What is persisted is the box, not the box minus what the session can account
  // for — and the type says so too, so a host that reintroduced the strip would
  // be contradicting the field's contract.
  assert.match(surface, /await writeMeetingDraft\(store, \{\s*title: this\.#state\.title,\s*transcript: this\.#state\.transcript,/);
  assert.match(read("../../lib/meetings/meetingDraft.ts"), /never `MeetingDraftReconciliation\.retained`/);
});

test("the durability slots follow the user out of the dialog", () => {
  // The × and the scrim close the compose dialog WITHOUT stopping the
  // recording, so a meeting can be captured with nothing of it on screen — and a
  // warning rendered only inside a closed dialog is a warning nobody can act on.
  // A render arrangement, which is why it is asserted here.
  assert.match(page, /\{!cap\.createOpen && cap\.warning \?/);
  assert.match(page, /\{!cap\.createOpen && cap\.notice \?/);
  // `capturing` and not `recording`: closing the dialog does not file the
  // meeting, and the capture this tab is holding is excluded from the offer, so
  // keyed on `recording` a person who stopped and closed the dialog had a
  // finished recording on their device with nothing on the page saying so and a
  // Record button that refused without explanation.
  assert.match(page, /\{!cap\.createOpen && cap\.capturing \?/);
  // Two slots, not one: the notice is a READING rewritten by every chunk and the
  // warning is an EVENT that is still true. Sharing one slot meant the
  // highest-frequency writer won and every warning that mattered was erased by
  // the next timeslice while it was still the case.
  assert.match(page, /\{cap\.notice \? <div className=\{styles\.errorBar\} role="status">/);
  assert.match(page, /\{cap\.warning \? <div className=\{styles\.errorBar\} role="alert">/);
  // …and the retained-audio list is outside the dialog on purpose: it is raised
  // by the same commit that closes it.
  const retained = page.indexOf("{cap.retained.map((row) => (");
  const dialog = page.indexOf("{cap.createOpen ? (");
  assert.ok(retained > 0 && dialog > retained, "the retained-audio notice is rendered before the dialog, outside it");
});

test("open question 5 — the recovery offer asks the shared rule, and the store no longer imitates it", () => {
  assert.match(surface, /resumableCaptures\(records, \{/);
  // The store cannot answer this — it treats the payload as opaque text — so the
  // predicate it used to restate is gone from it entirely.
  assert.doesNotMatch(store, /!record\.closed && record\.byteLength > 0/);
  assert.doesNotMatch(store, /async resumable\(|async attach\(/);
  assert.doesNotMatch(surface, /store\.resumable\(/);
});

test("F — the wake floor and the phase sentence are the shared ones", () => {
  // The two hosts did NOT agree: this file floored the queue's own `nextWakeMs`
  // with an inline `Math.max(500, …)` and the desktop's supervisor with a
  // private `MIN_WAKE_MS = 250`, so the same schedule probed a struggling
  // sidecar at two different rates depending on which host you were on.
  assert.match(surface, /const delay = drainWakeDelayMs\(result\.nextWakeMs\);/);
  assert.match(surface, /if \(delay !== null\) \{/);
  assert.deepEqual(
    codeLines(surface).filter((line) => line.includes("result.nextWakeMs")),
    ["const delay = drainWakeDelayMs(result.nextWakeMs);"],
    "the queue's raw schedule is read once, by the floor, and nowhere else",
  );
  // …and the live panel's sentence comes from the shared module, not a local
  // copy of it. The dashboard's copy is deleted, not merely unused.
  assert.match(live, /capturePhaseNote,/);
  assert.doesNotMatch(live, /from "\.\.\/\.\.\/lib\/meetings\/capturePhase"/);
  assert.match(live, /capturePhaseNote\(session, phase, \{ gaps, provisional \}\)/);
  // D4 — three states rendered as three different things.
  assert.match(live, /entry\.state === "transcribing" \? "Transcribing…" : "Queued"/);
});

# ADR-035 — A meeting you cannot lose

**Status:** PROPOSED — for owner review.
**Depends on:** ADR-018 (meetings capture/transcribe/summarize), ADR-028 (surfaces that tell the truth),
ADR-027 D12 (distributed-systems correctness), ADR-029 (one workspace, many surfaces).

---

## 1. Where we are

Capture works, and it has one shape: **hold everything in memory, transcribe once at the end.**

`brainrouter-desktop/src/components/meetings/MeetingsView.tsx`:

```ts
recorderRef.current = recorder; chunksRef.current = [];                                    // :394
recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };  // :395
recorder.onstop = () => { …; void transcribe(new Blob(chunksRef.current, …)); };            // :396
```

`chunksRef` is a React ref. The audio for the entire meeting lives in the renderer's heap until
`onstop`, at which point every chunk is concatenated into one `Blob` and posted in a single request
to `/v1/audio/transcriptions`, which proxies to the Whisper sidecar (`audioRoutes.ts:24`). On
failure, `transcribe` calls `setError(...)` (`:385`) and returns. **Nothing wrote the audio down.**

There is a draft, and it is worth being precise about what it covers: `DRAFT_KEY =
"brainrouter:desktop-meeting-draft"` (`:24`) persists the TEXT of the compose form — title,
template, pasted transcript. It does not persist audio. The "Draft recovered" badge (`:414`) is
therefore true and, for a recording that crashed, deeply misleading: the draft came back, the
meeting did not.

### 1.1 What that costs

Four failure modes, and the first three all end in silence:

- **The app closes mid-meeting.** A renderer crash, an app quit, an OS update, a laptop sleeping
  badly, a power loss. `chunksRef` is heap. The recording is gone — not degraded, gone — and the
  user finds out when they come back to a window that no longer knows it was recording.
- **Transcription fails.** The sidecar is down, the network drops, the body exceeds
  `BRAINROUTER_STT_MAX_BODY` (default `40mb`, `audioRoutes.ts:20`). The blob existed only in the
  heap of the function that just failed. There is no retry, because there is nothing left to retry
  from.
- **The meeting is simply long.** One hour of WebM is comfortably past 40 MB. The upload is
  all-or-nothing, so the longer the meeting the likelier the failure AND the more it costs. The
  failure probability rises exactly as the value of the recording does.
- **Nothing is visible until the end.** No text exists during the meeting. A user cannot correct a
  name, cannot see that the mic was on the wrong device, cannot tell whether it is working at all.
  The first evidence that capture succeeded arrives after the only moment when it could have been
  fixed.

> **A recording that exists only in RAM is not a recording. It is a bet that nothing goes wrong for
> an hour.**

---

## 2. The idea

Two changes, and the order matters.

> **Durability first, then liveness.** Audio becomes bytes on disk before it becomes anything else;
> transcription becomes a stream of segments over a meeting that already survives.

Liveness without durability is the worse of the two failures — it would show text during the meeting
and still lose everything on a crash, while feeling safer. So durability is D1 and liveness is built
on top of it.

---

## 3. Decisions

### D1 · Audio is written to disk as it arrives, never accumulated in memory

`ondataavailable` appends each chunk to a segment file under a per-meeting capture directory,
before anything else happens to it. `chunksRef` stops existing.

The recorder gets an explicit timeslice so chunks arrive on a fixed cadence rather than only at
stop — without one, `MediaRecorder` may deliver a single blob at the end and the disk write buys
nothing.

> **The test is not "does it save at the end". It is: kill the app mid-recording, and the audio up
> to that instant is on disk and playable.**

### D2 · A meeting is a session with an id, created at Record, not at Stop

Today a meeting row appears only when capture succeeded. That is why a failed capture has nowhere
to live. Pressing Record creates the session — id, started-at, device, language, template — and the
capture directory is named by it. Everything after is an append to something that already exists.

This is also what makes a crash recoverable rather than merely detectable: on next launch, a session
with audio and no terminal state is offered back to the user.

### D3 · Transcription is incremental, and its unit is a segment

Each segment is transcribed as it lands, against the same STT endpoint, and appended to the
transcript with its time range. Three things follow, and each is a fix for a failure above:

- **Text exists during the meeting** (D4).
- **A failure is bounded to one segment.** One 30-second segment fails; the other 119 do not, and
  the failed one is retried from the file that is already on disk.
- **The 40 MB body limit stops being a ceiling on meeting length**, because nothing ever posts an
  hour of audio in one request.

### D4 · Live text is the surface, and it distinguishes provisional from settled

The compose view shows transcript text as it is produced. Segments still in flight are visibly
provisional; segments that have been transcribed and persisted are settled. A user editing settled
text must not have their edit overwritten by a late-arriving segment.

Per ADR-028: the surface says which state it is in. "Transcribing…" on a segment that failed twenty
minutes ago is the failure this ADR is trying to end, wearing a spinner.

### D5 · A failed segment is retryable, visibly, and never silently dropped

A segment that cannot be transcribed stays in the transcript as a gap with its time range and a
retry affordance — not an omission. Retries are bounded and backed off; the audio stays on disk
until the user resolves or discards the meeting.

> **A transcript with an unmarked hole in it is worse than one that says "00:12:30–00:13:00 could
> not be transcribed".** The first is quietly wrong; the second is a fact a person can act on.

### D6 · Retention is explicit, and deletion is a real deletion

Captured audio is the most sensitive artifact this product writes to disk. So:

- the capture directory is `0700`, and files within it `0600` (cf. ADR golden rule 22 and the
  `saveConfig` mode fix);
- audio is deleted when the meeting is summarized and the user has accepted it, or on an explicit
  discard, or after a retention window the user can see and set;
- an orphaned capture directory with no session row is reaped at boot, and the reap is logged.

**Audio is never written to `localStorage` or any renderer-accessible store.** The existing text
draft should move to the same protected location for the same reason — meeting content is not
credential material, but it is not something to leave in a store any page script can read.

### D7 · Local-first, with the network as an accelerator

Capture and disk persistence require no network at all. Transcription prefers the configured STT
endpoint and degrades to queued-on-disk when it is unavailable: the meeting continues, segments
accumulate, and transcription drains when the endpoint returns.

A meeting must never fail because a server was down. That is the whole point of writing the bytes
first.

### D8 · Import and paste keep working, unchanged

`importAudio` and pasted transcripts are existing, working paths. They gain durability by joining
the same session model (D2), and are otherwise untouched. This ADR adds a floor; it does not
redesign what already works.

---

## 4. What this explicitly does not do

- **No speaker diarization.** Valuable, and a separate decision with its own model and privacy
  questions.
- **No system-audio / other-participant capture.** Today's capture is `getUserMedia({ audio: true })`
  — the local microphone. Capturing the far side of a call raises consent and platform questions
  this ADR is not the place to settle.
- **No new STT engine.** The sidecar contract (`audioRoutes.ts`) is unchanged; only the size and
  cadence of what is sent to it change.

---

## 5. Open questions

1. **Segment length.** Long enough for the model to have context, short enough that a failure is
   cheap and text feels live. 15–30s is the obvious starting range; it should be measured against
   transcription quality rather than guessed, because too-short segments cut words in half.
2. **Where does the capture directory live?** The desktop already has an app-data root and a
   per-session browser partition. Reusing an existing rooted location beats inventing one.
3. **Who owns retry — renderer or host?** A renderer-owned queue dies with the window, which is the
   defect this ADR exists to fix; a host-owned queue survives and can drain after a restart.
4. **Does the hosted path get the same guarantee?** A meeting captured on the desktop and a meeting
   captured through the dashboard should not have different durability, and the dashboard has no
   disk.
5. **What happens to an in-flight meeting when the org context switches?** ADR-019's switcher scopes
   meetings; a recording that started under one org must not silently land in another.

---

## 6. How this will be judged

**One test, and it is destructive on purpose.**

> Start a recording. Speak for two minutes. **Kill the application** — not close, kill. Reopen it.

The meeting must be there, the audio up to the kill must be on disk and playable, the transcript for
every completed segment must be present, and the session must offer to resume or finalize.

Today, that test loses everything.

Two supporting criteria, because the destructive test alone can be satisfied badly:

- **A meeting longer than the body limit completes.** Record past 40 MB of audio. It transcribes,
  because no request ever carries the whole thing.
- **A failed segment is visible and recoverable.** Point the STT endpoint at a black hole for sixty
  seconds mid-meeting. Those segments appear as marked gaps, the rest of the transcript is intact,
  and retrying after the endpoint returns fills them in from the audio still on disk.

Not judged by: whether live text looks good. It will. The question is what remains when something
goes wrong, because that is the case the current design answers with silence.

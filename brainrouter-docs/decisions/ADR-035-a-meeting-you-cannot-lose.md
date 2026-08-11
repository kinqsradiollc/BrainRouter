# ADR-035 — A meeting you cannot lose

**Status:** ACCEPTED — owner-approved. D1/D1b/D2 built; D3/D4/D5/D7 built and hardened;
D9 implemented with automated host coverage, with destructive acceptance still pending; D10/D11
and D6's retention window are not built.
**Depends on:** ADR-018 (meetings capture/transcribe/summarize), ADR-028 (surfaces that tell the truth),
ADR-027 D12 (distributed-systems correctness), ADR-029 (one workspace, many surfaces).

---

## 1. Pre-implementation baseline

When this decision was written, capture had one shape: **hold everything in memory, transcribe once
at the end.** The code below records that baseline; later decisions in this ADR replace it.

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

### D1 · Audio is written to durable storage as it arrives, never accumulated in memory

`ondataavailable` appends each chunk to a segment file under a per-meeting capture directory,
before anything else happens to it. `chunksRef` stops existing.

The recorder gets an explicit timeslice so chunks arrive on a fixed cadence rather than only at
stop — without one, `MediaRecorder` may deliver a single blob at the end and the disk write buys
nothing.

> **The test is not "does it save at the end". It is: kill the app mid-recording, and the audio up
> to that instant is on disk and playable.**

### D1b · The dashboard gets the SAME guarantee, not a lesser one

A meeting captured in the browser must survive a crash exactly as one captured on
the desktop does. The mechanism differs because the storage does; the promise
does not.

The browser is not the memory-only environment it used to be:

- **OPFS** (Origin Private File System) gives real, quota-backed file writes and
  is the closest analogue to D1's disk append — chunks land as they arrive.
- **IndexedDB** is the fallback where OPFS is unavailable, storing chunks as
  blobs keyed by session and sequence.

Both survive a tab crash, a reload, and the browser being closed. Neither is
`localStorage`, which is synchronous, small, and the wrong tool for megabytes of
audio (and, per golden rule 22, not somewhere product data of this weight
belongs).

> **The session model, the segment protocol, and the recovery flow are shared.
> Only the write target is host-specific.** If the dashboard needed a different
> session shape, we would end up with two meeting features and the second would
> quietly be the worse one — which is the ADR-029 failure this repo keeps paying
> for.

Two things the browser makes harder, and neither is a reason to accept less:

- **Quota.** OPFS and IndexedDB are bounded and can be evicted. The recorder must
  ask for persistent storage, watch its budget, and tell the user BEFORE it is a
  problem — an eviction discovered at Stop is the same silent loss this ADR
  exists to end.
- **A closing tab gets very little time.** So durability cannot depend on an
  unload handler running. Chunks are already written; nothing important may be
  deferred to the moment the tab dies.

### D2 · A meeting is a session with an id, created at Record, not at Stop

In that baseline, a meeting row appeared only when capture succeeded. That is why a failed capture
had nowhere to live. Pressing Record now creates the session — id, started-at, device, language,
template — and the capture directory is named by it. Everything after is an append to something
that already exists.

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

- on the desktop, the capture directory is `0700` and files within it `0600` (cf. ADR golden rule 22
  and the `saveConfig` mode fix); in the browser, OPFS/IndexedDB are already origin-scoped, and the
  equivalent obligation is that the data is deleted on the same schedule rather than left to quota;
- audio is deleted when the meeting is summarized and the user has accepted it, or on an explicit
  discard, or after a retention window the user can see and set;
- an orphaned capture directory with no session row is reaped at boot, and the reap is logged.

**Audio is never written to `localStorage` or any renderer-accessible store.** The existing text
draft should move to the same protected location for the same reason — meeting content is not
credential material, but it is not something to leave in a store any page script can read.

**D6a · Where we cannot tell whether a meeting is live, we ask rather than guess.** Added after
building it. "Deleted on an explicit discard" assumes the product knows whether anything is still
writing, and one host sometimes cannot: a browser without Web Locks — a secure context on an older
Safari or Firefox, or an in-app WebView — has no way to see its own other tabs. Both available
answers were wrong. Deleting anyway destroyed a recording in progress; refusing forever left a
person unable to delete their own audio while the surface printed an instruction the interface did
not permit, which is a worse failure than the one it prevented.

So the third answer: state the consequence and honour the reply. It is not a fallback to be
embarrassed about — it is the only honest thing to say when the question genuinely cannot be
answered, and per golden rule 23 the surface says which mode it is in.

> **Liveness is not stored.** It was, briefly, as a heartbeat in the capture record, and that was
> wrong in both directions at once — a killed meeting stayed invisible for the staleness window
> while a reloaded window's recording was stranded for ever. Each host is now asked the question by
> the thing that already knows the answer: the desktop's per-process writer map behind a
> single-instance lock, and the browser's Web Lock, which the browser itself releases when the tab
> dies. That is exactly §6's test, which a timer can only approximate.

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

## 3b. Decisions added after using it

D1–D8 were written before anything was built. The three below come from running the result: the
capture is durable and the live text is slow, and the reason turned out to be a mistake in D3 rather
than a number that needed tuning.

### D9 · The durability chunk and the transcription unit are different things

D3 said "the unit of transcription is a segment" and D1 said chunks are written as they arrive, and
the pre-D9 implementation quite reasonably made those **one 20-second constant**
(`DEFAULT_MEETING_SEGMENT_MS`). That constant was doing three jobs with three different right
answers:

| concern | what it actually wants |
|---|---|
| **durability** — bound the worst-case loss | short: 2–5s. A crash costs seconds, not twenty. |
| **transcription quality** — the model needs context | utterance-shaped, decided by speech, not by a clock |
| **liveness** — text appears while talking | continuous; anything clock-shaped has a floor |

One number cannot satisfy those. Twenty seconds is simultaneously too long to lose, arbitrary as a
linguistic boundary — it cuts sentences in half, which §5.1 warned about and then did anyway — and
far too coarse to feel live.

**So they separate.** The durability chunk is small and is written as it arrives. What gets sent for
transcription is assembled from those chunks and is sized by the transcription strategy, not by the
write cadence.

> **Shrinking the segment is not the fix, and would make it worse.** A batch upload's latency floor
> is about half the segment plus decode plus round-trip, so halving it halves nothing that matters
> while cutting more words in half. The knob was the wrong knob.

### D10 · Live transcription is a streaming session where the endpoint offers one

Batch-posting a file per segment cannot produce live text, whatever the segment size. Streaming
transcription APIs — including the one this was measured against — hold a persistent connection,
accept audio continuously, and return **incremental deltas while the person is still speaking**,
with utterance boundaries decided server-side by voice activity or by a model judging the thought
complete, and with an explicit latency-versus-accuracy control rather than a fixed cadence.

So transcription becomes two strategies behind one port:

- **streaming** where the configured endpoint supports it — continuous audio up, deltas down, which
  is what D4's "provisional" state was always describing;
- **segmented upload** — today's path — as the fallback, and as what drains a queue after an outage.

**The strategy is a property of the endpoint, not of the host.** Both hosts get whichever the
endpoint supports, or D1b's promise breaks again in a new place.

Durability does not move. Chunks are still written before anything is sent, so a dropped connection
costs a reconnect and not a meeting — and the queue that already exists is what replays what the
stream did not acknowledge.

### D11 · In the browser, the server is the system of record — not the origin's quota

D7 made the local disk the source of truth and the network an accelerator. That is right for the
desktop and **wrong for the browser**, because the browser is the host whose storage can be taken
away from it.

`navigator.storage.persist()` can simply be refused — it is granted on engagement heuristics, not on
asking — and eviction under pressure is per-origin. A refused grant means a long meeting can be
evicted mid-recording, and no amount of quota-watching prevents it. Warning earlier does not fix it;
it only narrates it.

**The fix is that the bytes leave the machine.** Once audio is streaming (D10) or uploading as it is
captured, local storage stops being the system of record and becomes what it should have been: a
buffer for the offline case, sized to the outage rather than to the meeting.

Two things that are worth doing whatever else happens, because they are cheap and reduce the exposure
now:

- **Record speech at a speech bitrate.** `new MediaRecorder(stream)` is constructed with no options
  on both hosts, so it uses the browser default of roughly 128 kbps — about 60 MB an hour. Speech is
  fine at 24–32 kbps, which is nearer 15 MB. A four-fold cut in the thing being evicted.
- **Say which promise the user has.** "Persisted" and "best-effort" are different guarantees and the
  surface currently shows the same face for both. Per ADR-028, the one that can lose your meeting
  should not look like the one that cannot.

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

1. ~~**Segment length.**~~ **ANSWERED, and the question was wrong.** It was measured: 20s was
   chosen from the "obvious starting range" below and the result is visibly slow. But the finding is
   not that the number should be smaller — it is that one number was serving three concerns with
   three different right answers. See **D9**. The implemented durability default is three seconds,
   within the 2–5s bound; the destructive host acceptance still has to validate that choice. The
   streaming endpoint's latency setting remains a separate open question with separate evidence.
2. **Where does the capture directory live?** The desktop already has an app-data root and a
   per-session browser partition. Reusing an existing rooted location beats inventing one.
3. **Who owns retry — renderer or host?** A renderer-owned queue dies with the window, which is the
   defect this ADR exists to fix; a host-owned queue survives and can drain after a restart.
4. ~~**Which browser store, and what happens at the quota edge?**~~ **PARTLY ANSWERED, and the
   framing was wrong.** OPFS with an IndexedDB fallback stands. But "how early is the user warned"
   assumed warning was the remedy, and it is not: persistence can be refused outright and eviction
   is per-origin, so a long meeting can vanish no matter how early we said something. See **D11** —
   the remedy is that the bytes leave the machine. What remains genuinely open is what the local
   buffer should hold once the server is the record: how much outage it must survive, and what it
   does when that budget is exhausted anyway.
5. **What happens to an in-flight meeting when the org context switches?** ADR-019's switcher scopes
   meetings; a recording that started under one org must not silently land in another.

---

## 6. How this will be judged

**One test, and it is destructive on purpose.**

> Start a recording. Speak for two minutes. **Kill the application** — not close, kill. Reopen it.
>
> Run it on BOTH hosts: kill the desktop app, and kill the browser tab (and then the whole browser).
> A meeting captured in the dashboard must come back exactly as one captured on the desktop does.

The meeting must be there, the audio up to the kill must be on disk and playable, the transcript for
every completed segment must be present, and the session must offer to resume or finalize.

In the pre-ADR baseline, that test lost everything. D9 now has automated coverage for bounded
seconds-scale loss, but the destructive run on both hosts remains a release acceptance requirement.

Two supporting criteria, because the destructive test alone can be satisfied badly:

- **A meeting longer than the body limit completes.** Record past 40 MB of audio. It transcribes,
  because no request ever carries the whole thing.
- **A failed segment is visible and recoverable.** Point the STT endpoint at a black hole for sixty
  seconds mid-meeting. Those segments appear as marked gaps, the rest of the transcript is intact,
  and retrying after the endpoint returns fills them in from the audio still on disk.

For D9–D11, three more, because "it feels faster" is not checkable either:

- **Text appears while the sentence is still being spoken.** Not after it. If the first text for an
  utterance arrives only once the utterance is over, D10 did not land — whatever the segment size.
- **The worst case is seconds.** Kill it mid-sentence and count what is missing. D9 is the claim
  that this is bounded by the write cadence, not by the transcription unit; if they are still the
  same number, nothing changed.
- **Refuse persistence and record for an hour anyway.** In a browser where
  `navigator.storage.persist()` returns false, the meeting must still be recoverable — because the
  bytes are elsewhere. If the answer is a louder warning, D11 was not built.

Not judged by: whether live text looks good. It will. The question is what remains when something
goes wrong, because that is the case the pre-ADR design answered with silence.

/**
 * ADR-035 D1/D1b/D2 — the durable capture protocol, in the one place both
 * browser backends share.
 *
 * This module owns every decision the dashboard makes about a recording that is
 * still being written: what sequence a chunk gets, what order the writes happen
 * in, what counts as "there is audio here", which sessions are offered back
 * after a crash, and when the store says the quota is about to become a problem.
 * The backends underneath it (`opfsCaptureBackend.ts`, `indexedDbCaptureBackend.ts`)
 * move bytes and hold no policy, which is what lets the whole protocol be
 * exercised by a test in a runner that has neither OPFS nor IndexedDB.
 *
 * Three properties this is built to have, each of which is a failure mode from
 * ADR-035 §1.1 turned around:
 *
 * - **Nothing important is deferred.** `read` derives a session's audio from
 *   what the backend actually holds, not from a bookkeeping record. A tab that
 *   dies between the chunk write and any subsequent write still comes back with
 *   every chunk it wrote. D1b: "a closing tab gets very little time", so the
 *   design is not allowed to want any.
 * - **Every access to a session is serialized behind its writes.**
 *   `MediaRecorder` fires `ondataavailable` from an event handler that will not
 *   wait for a promise, so two chunks can be in flight at once. Without a queue
 *   they would race for a sequence number and one would overwrite the other —
 *   silently, which is the whole category of bug this ADR is about. Reads and
 *   deletes join the SAME queue, because the two operations that follow the last
 *   chunk are exactly "read it back" and "throw it away": a `readAudio` that
 *   overtakes the final `writeChunk` hands transcription a truncated meeting,
 *   and a `delete` that overtakes it lets the late write re-create the session
 *   directory holding one orphaned chunk and no manifest. The MANIFEST writes
 *   (`begin`, `setPayload`) are on it for the mirror-image reason: both are
 *   read-then-write pairs, and a delete landing between the two halves either
 *   erases a session that has just begun or resurrects one the user threw away.
 * - **A failed write does not consume a sequence.** If the bytes did not land,
 *   the number is still free, so the recording continues without a hole in it.
 *
 * The store never parses `payload`. It is whatever the caller's session model
 * serialized (see `captureStorage.ts` for why that boundary is where it is).
 */
import { DEFAULT_MEETING_SEGMENT_MS } from "@kinqs/brainrouter-core/meetings";

import {
  assertCaptureSessionId,
  type CaptureChunkRef,
  type CaptureManifest,
  type CaptureStorageBackend,
  type CaptureStorageKind,
} from "./captureStorage";
import {
  captureRecordingRate,
  evaluateCaptureBudget,
  type CaptureBudget,
} from "./storageBudget";

/**
 * ADR-035 D1/§5.1 — the recorder's chunk cadence.
 *
 * D1 is explicit that `MediaRecorder` needs an explicit timeslice, because
 * without one it may deliver a single blob at the end and the durable write buys
 * nothing. The number is the SHARED one: a chunk is a segment (D3), so the
 * cadence a browser records at and the length a segment is transcribed in are
 * the same decision, and open question 1 asks for it to be measured once rather
 * than guessed twice.
 *
 * The alias exists because the two names mean different things at their own
 * layer — this one is an argument to `MediaRecorder.start()` — and a reader here
 * should not have to know that a "segment" is what the shared model calls it.
 */
export const MEETING_CAPTURE_TIMESLICE_MS = DEFAULT_MEETING_SEGMENT_MS;

/** A stored session as the store sees it: manifest fields plus measured audio. */
export interface CaptureSessionRecord {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly closed: boolean;
  readonly payload: string;
  /** Sorted by sequence, always — never the backend's listing order. */
  readonly chunks: readonly CaptureChunkRef[];
  readonly byteLength: number;
}

/**
 * Reassembled audio, and an honest account of what could not be read.
 *
 * `missing` exists because the alternative designs are both worse: throwing on
 * one unreadable chunk would deny a user the other fifty-nine minutes of their
 * meeting, and skipping silently would hand back a recording with an
 * unannounced hole in it — D5's "quietly wrong" transcript, one layer down.
 */
export interface CaptureAudio {
  readonly blob: Blob;
  readonly byteLength: number;
  readonly missing: readonly number[];
}

export interface MeetingCaptureStoreOptions {
  /**
   * Quota seam. `navigator.storage.estimate` in the browser; a function in a
   * test. The store watches the budget but does not know how to ask for it.
   */
  readonly estimate?: () => Promise<{ usage?: number; quota?: number }>;
  /** Whether persistent storage was granted (see `ensureCapturePersistence`). */
  readonly persisted?: boolean;
}

export interface BeginCaptureInput {
  readonly sessionId: string;
  readonly startedAt?: string;
  readonly payload?: string;
}

export interface ReapOrphansOptions {
  /**
   * Ids the reap must not touch whatever their manifest says — in practice the
   * recording in hand and the compose draft's reserved record. Everything else
   * the store can judge for itself; this is the one fact only the caller has.
   */
  readonly keep?: readonly string[];
  /**
   * Whether a manifest holding NO audio has been abandoned and may be reclaimed
   * — asked about a manifest the reap has JUST read.
   *
   * Two reasons it is the caller's question and not the store's, and they pull
   * the same way. The store cannot read a payload, so it cannot tell that one
   * reserved id in this listing is not a meeting at all; and it cannot see the
   * browser's lock table, which is where "a tab is recording into this right
   * now" actually lives. And `keep` cannot stand in for it: `keep` is built from
   * a listing the caller took earlier, and OPFS is scoped to the ORIGIN, so a
   * session another tab began in between is absent from `keep` and present here
   * — which does not matter while every live capture is protected by holding
   * audio, and matters completely the moment a chunk-less manifest becomes
   * reapable, because a recording is exactly that for as long as the microphone
   * prompt is on screen.
   *
   * **It may answer asynchronously, and the reap waits for it.** That is not a
   * convenience: the authoritative liveness answer on this host is
   * `navigator.locks.query()`, which is a promise, and a predicate forced to be
   * synchronous could only consult something taken EARLIER — which is precisely
   * the stale reading this argument exists to avoid.
   *
   * Absent, a manifest with no audio is NEVER reaped. That is the safe default
   * and deliberately the old behaviour: a caller that has not said which of its
   * records are meetings must not have one deleted on its behalf.
   */
  readonly abandoned?: (record: {
    readonly sessionId: string;
    readonly startedAt: string;
    readonly payload: string;
  }) => boolean | Promise<boolean>;
}

export class MeetingCaptureStore {
  readonly kind: CaptureStorageKind;

  readonly #backend: CaptureStorageBackend;
  readonly #estimate?: () => Promise<{ usage?: number; quota?: number }>;
  readonly #persisted: boolean;
  /** Next free sequence per session, seeded from the backend on first use. */
  readonly #next = new Map<string, number>();
  /** Per-session write queue; see the serialization note in the module header. */
  readonly #tail = new Map<string, Promise<unknown>>();

  constructor(backend: CaptureStorageBackend, options: MeetingCaptureStoreOptions = {}) {
    this.#backend = backend;
    this.kind = backend.kind;
    this.#estimate = options.estimate;
    this.#persisted = options.persisted === true;
  }

  get persisted(): boolean {
    return this.#persisted;
  }

  /**
   * D2 — pressing Record creates the session, before a single byte of audio
   * exists. Everything after is an append to something already on disk.
   *
   * Refuses to write over an existing manifest: the only way that happens is a
   * caller reusing an id, and the loser of that collision would be a recording
   * someone still wants. A session found at load is continued by reading it
   * (`read`) and appending, which is what `restoreCaptureSession` already does —
   * the sequence counter seeds itself from the chunks on first append.
   *
   * On the SAME queue as every other write, and the check and the write are one
   * task on it. Off the queue, the read that finds no manifest and the write
   * that creates one straddle any delete already queued for that id — so a reap
   * or a discard could land between them and erase the manifest of a recording
   * that had just started, leaving chunks arriving into a session `list` cannot
   * see. That is the same read-modify-write hazard `setPayload` has, on the one
   * operation where losing it costs a live meeting.
   */
  async begin(input: BeginCaptureInput): Promise<CaptureSessionRecord> {
    const sessionId = assertCaptureSessionId(input.sessionId);
    return this.#serialize(sessionId, async () => {
      const existing = await this.#backend.readManifest(sessionId);
      if (existing) throw new Error(`A meeting capture named ${sessionId} already exists.`);
      const manifest: CaptureManifest = {
        startedAt: input.startedAt ?? new Date().toISOString(),
        closed: false,
        payload: input.payload ?? "",
      };
      await this.#backend.writeManifest(sessionId, manifest);
      this.#next.set(sessionId, await this.#seedSequence(sessionId));
      return this.#record(sessionId, manifest);
    });
  }

  /**
   * D1 — the chunk becomes bytes before it becomes anything else.
   *
   * Resolves only once the backend reports the write complete, so a caller that
   * awaits this knows the audio survives the next instant. Callers that cannot
   * await (a `MediaRecorder` event handler) are still safe: the queue preserves
   * order and the sequence is allocated inside it.
   */
  async appendChunk(sessionId: string, bytes: Blob): Promise<CaptureChunkRef> {
    const id = assertCaptureSessionId(sessionId);
    if (!bytes || bytes.size <= 0) {
      // MediaRecorder emits empty blobs around pause/resume. Storing one would
      // spend a sequence on nothing and make `byteLength > 0` — the recovery
      // predicate — true for a session that holds no audio.
      throw new Error("A capture chunk must carry at least one byte of audio.");
    }
    return this.#serialize(id, async () => {
      const sequence = this.#next.get(id) ?? (await this.#seedSequence(id));
      await this.#backend.writeChunk(id, sequence, bytes);
      // Advanced only after the write resolved: a failed write leaves the
      // sequence free, so the next chunk fills it and the audio has no hole.
      this.#next.set(id, sequence + 1);
      return { sequence, byteLength: bytes.size };
    });
  }

  /**
   * Replace the caller's serialized session model, and optionally settle it.
   *
   * This is the transcription queue's `persist` port, so it runs while segments
   * are still landing and while the user may be discarding the meeting — and it
   * is a read-modify-write (it preserves `startedAt` and, unless told otherwise,
   * `closed`). Off the queue, its read and its write straddle a `delete`: the
   * read sees a live manifest, the delete removes the session, and then the
   * write puts a manifest BACK, re-creating a zero-byte session that `resumable`
   * will not offer and no user can remove. D6 says deletion is a real deletion,
   * so the pair is one task on the same queue the delete is on.
   */
  async setPayload(
    sessionId: string,
    payload: string,
    options: { readonly closed?: boolean } = {},
  ): Promise<CaptureSessionRecord> {
    const id = assertCaptureSessionId(sessionId);
    return this.#serialize(id, async () => {
      const manifest = await this.#backend.readManifest(id);
      if (!manifest) throw new Error(`No meeting capture named ${id} is stored.`);
      const next: CaptureManifest = { ...manifest, payload, closed: options.closed ?? manifest.closed };
      await this.#backend.writeManifest(id, next);
      return this.#record(id, next);
    });
  }

  async read(sessionId: string): Promise<CaptureSessionRecord | undefined> {
    const id = assertCaptureSessionId(sessionId);
    const manifest = await this.#backend.readManifest(id);
    return manifest ? this.#record(id, manifest) : undefined;
  }

  /**
   * Resolve once every write queued for a session (or for every session) has
   * landed or failed.
   *
   * This exists because `MediaRecorder` delivers its final chunk from
   * `ondataavailable` and then fires `onstop` immediately after, and no handler
   * on that path can await anything. Without a public drain, Stop reads the
   * audio back while the last twenty seconds are still being written, hands
   * transcription a truncated meeting, and then deletes the session on success —
   * losing the very chunk that was in flight. The desktop recorder awaits its
   * own queue at exactly this point; D1b asks for the same guarantee here, not a
   * lesser one.
   */
  async settled(sessionId?: string): Promise<void> {
    // Bounded rather than "loop until nothing is queued": a drain must not be
    // somewhere a producer can hang the Stop button forever. Each pass waits for
    // everything queued when it began, and re-checks because a task can enqueue
    // another behind it — for the case this exists for, one pass is already
    // enough.
    for (let pass = 0; pass < CAPTURE_DRAIN_PASSES; pass += 1) {
      const pending: Promise<unknown>[] = [];
      if (sessionId === undefined) {
        pending.push(...this.#tail.values());
      } else {
        const tail = this.#tail.get(assertCaptureSessionId(sessionId));
        if (tail) pending.push(tail);
      }
      if (pending.length === 0) return;
      // Every tail promise has already swallowed its rejection, so this settles
      // on a failed write rather than throwing the failure at the drainer.
      await Promise.all(pending);
    }
  }

  /**
   * D1b's destructive test, from the store's side: everything written up to the
   * kill, in the order it was spoken.
   *
   * §6 judges this ADR on the audio being "on disk AND PLAYABLE", so this is
   * what the recovery surface's Play control reads — a recovered meeting whose
   * transcript comes back but whose recording can never be heard passes the
   * first half of that criterion and fails the second.
   *
   * Queued behind this session's writes, so the answer includes the chunk that
   * was still in flight when Stop was pressed.
   *
   * **Unreadable is unreadable, whatever the reason.** A chunk that reads back
   * `undefined` and a chunk whose read THROWS are the same fact about the same
   * twenty seconds of audio, and both belong in `missing`. Letting the throw
   * escape made one bad chunk deny the user the whole meeting — `preview` came
   * back null and fifty-nine playable minutes went unheard — and it is not a
   * hypothetical shape: the IndexedDB backend's request wrapper rejects on
   * `onerror`/`onabort`, and OPFS's `getFile()` throws when the entry is gone or
   * the file is locked. The desktop answers this injury with `missing=[2]`; D1b
   * says this host gets the same guarantee and not a lesser one.
   */
  async readAudio(sessionId: string, type = "audio/webm"): Promise<CaptureAudio> {
    const id = assertCaptureSessionId(sessionId);
    return this.#serialize(id, async () => {
      const chunks = await this.#chunks(id);
      const parts: Blob[] = [];
      const missing: number[] = [];
      let byteLength = 0;
      for (const chunk of chunks) {
        let blob: Blob | undefined;
        try {
          blob = await this.#backend.readChunk(id, chunk.sequence);
        } catch {
          // Named below with every other chunk this device could not hand back.
          blob = undefined;
        }
        if (!blob) {
          missing.push(chunk.sequence);
          continue;
        }
        parts.push(blob);
        byteLength += blob.size;
      }
      return { blob: new Blob(parts, { type }), byteLength, missing };
    });
  }

  /**
   * ADR-035 D3 — the audio for ONE segment, which is the unit transcription
   * actually works in.
   *
   * The whole-capture `readAudio` is deliberately not what the transcription
   * path uses: D3 removes the body-size ceiling precisely by never assembling
   * the meeting, so reading it back in one piece to send a piece of it would put
   * the hour of audio the ADR is trying to stop handling straight back into the
   * tab's heap.
   *
   * Queued behind this session's writes for the same reason `readAudio` is: the
   * segment being retried may be the one still being written.
   */
  async readSegment(sessionId: string, sequence: number): Promise<Blob | undefined> {
    const id = assertCaptureSessionId(sessionId);
    return this.#serialize(id, () => this.#backend.readChunk(id, sequence));
  }

  /** Every session with a manifest, newest first — the order a user reads them in. */
  async list(): Promise<readonly CaptureSessionRecord[]> {
    const ids = await this.#backend.listSessionIds();
    const records: CaptureSessionRecord[] = [];
    for (const id of ids) {
      const manifest = await this.#backend.readManifest(id);
      if (manifest) records.push(await this.#record(id, manifest));
    }
    return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  // D2's recovery offer is deliberately NOT a method here. "A session with audio
  // and no terminal state" is the shared `isResumableSession`, and open question
  // 5 adds a scope to it — neither of which this class can see, because it treats
  // `payload` as opaque text on purpose. A `!closed && byteLength > 0` written
  // out here was that rule imitated rather than called, and an imitation cannot
  // grow a scope: it offered a capture recorded under one organization back under
  // another. `resumableCaptures` in `capturePayload.ts` owns the answer, over
  // `list()`, where the payload is understood.

  /**
   * D6 — a real deletion, and one an in-flight write cannot undo.
   *
   * Queued behind this session's writes for a reason the quota depends on: a
   * `writeChunk` that lands after the directory is removed re-creates it
   * (`getDirectoryHandle(sessionId, { create: true })`) holding one chunk and no
   * manifest. `list` skips manifest-less sessions, so `resumable` could never
   * surface it and no user could ever delete it — audio stranded in the origin's
   * budget forever.
   */
  async delete(sessionId: string): Promise<void> {
    const id = assertCaptureSessionId(sessionId);
    await this.#serialize(id, async () => {
      await this.#backend.deleteSession(id);
      // The sequence counter, but NOT the queue entry: `#serialize` prunes that
      // itself once nothing is queued behind it, and dropping it here would
      // orphan a chunk enqueued while this delete was running.
      this.#next.delete(id);
    });
  }

  /**
   * Everything the backend holds, including audio whose manifest is gone — the
   * snapshot `reapOrphans` decides from, and the only listing that can see a
   * capture no session claims.
   */
  async listStoredSessionIds(): Promise<readonly string[]> {
    return this.#backend.listSessionIds();
  }

  /**
   * D6 — captures nothing can offer back are deleted, and the caller is told
   * which, so the reap can be logged.
   *
   * **The store decides what is claimed, from ONE snapshot.** It used to take a
   * list of known ids from the caller and then take its own, LATER listing — and
   * a session that pressed Record between those two moments was absent from the
   * first and present in the second, so the reap deleted a recording that was in
   * progress. That is not a narrow window: the load-time reap and the Record
   * path routinely hold different `MeetingCaptureStore` instances over the same
   * origin, and the reap runs again after every finish, discard and pick-up. The
   * desktop's `recoverInterrupted` never had this bug because it takes one
   * snapshot first and only ever deletes from it; so does this now.
   *
   * A manifest IS the session row here — `begin` writes it before a single byte
   * of audio exists — so "claimed" needs no list from anybody. Two kinds of
   * capture are reaped:
   *
   * - **Orphans**: chunks with no manifest. Audio `list` cannot see, `resumable`
   *   cannot offer and no user can delete, holding origin quota forever.
   * - **Settled captures**: a manifest marked `closed`. `releaseCapture` writes
   *   the terminal record BEFORE deleting the audio (so a kill in between leaves
   *   a meeting that will not be offered back), which means a delete that failed
   *   or never ran leaves exactly this. The desktop reaps terminal captures on
   *   sight for the same reason; without it, audio the user accepted or threw
   *   away outlives the deletion they asked for.
   * - **Captures abandoned before their first chunk**: a manifest that is not
   *   closed, holds no audio, and that nobody is writing to. `begin` runs before
   *   `getUserMedia`, so a tab killed while the microphone prompt is on screen
   *   leaves exactly this — and it is unreachable by every other path: the reap
   *   used to skip it (`!manifest.closed`), `resumableCaptures` will never offer
   *   it (no audio), and no surface can name it. Metadata only, no audio at
   *   risk, and the desktop has reaped precisely this case with precisely this
   *   rationale since `recoverInterrupted` was written — so leaving it was the
   *   shared reap rule holding on one host and not the other.
   *
   * `keep` is for the recording in hand and for the draft's reserved record;
   * `writing` is for a recording ANOTHER TAB began after the caller last looked,
   * which `keep` structurally cannot cover.
   */
  async reapOrphans(options: ReapOrphansOptions = {}): Promise<readonly string[]> {
    const keep = new Set(options.keep ?? []);
    // Taken FIRST, and nothing outside it is ever deleted: a session that begins
    // after this line is not in `stored`, so the reap cannot see it, let alone
    // remove it. Everything below only narrows this set.
    const stored = await this.listStoredSessionIds();
    const reaped: string[] = [];
    for (const id of stored) {
      if (keep.has(id)) continue;
      const manifest = await this.#backend.readManifest(id);
      if (manifest && !manifest.closed) {
        // A session claimed by its own manifest. It holds audio, so whatever
        // else is true of it there is something here a person may still want —
        // this is the branch a recording in progress and a crashed one both take.
        const chunks = await this.#backend.listChunks(id);
        if (chunks.length > 0) continue;
        // No audio yet. Which used to end the question here, and that is defect
        // C: a tab killed during the microphone prompt left a manifest nothing
        // could offer, nothing could reap and no user could reach. The one thing
        // that separates it from a recording whose first chunk has not landed is
        // whether a tab is holding it — and this moment, not the caller's
        // earlier listing, is the only reading late enough to see a tab that
        // began after it. That question is the caller's to answer, and it is
        // awaited because the browser answers it asynchronously.
        if (!(await options.abandoned?.({ sessionId: id, startedAt: manifest.startedAt, payload: manifest.payload }))) continue;
      } else if (!manifest) {
        // No manifest AND no chunks: nothing to reclaim, and it is exactly what
        // a `begin` in another tab looks like for the instant between creating
        // the session directory and finishing its manifest write.
        const chunks = await this.#backend.listChunks(id);
        if (chunks.length === 0) continue;
      }
      // Deliberately NOT re-validated: this id came from the store's own listing
      // rather than from a caller, and a leftover whose name this model would
      // refuse to mint is precisely the kind of thing D6 asks to be reaped.
      // Queued like every other delete, so a reap cannot race a write.
      await this.#serialize(id, async () => {
        await this.#backend.deleteSession(id);
        this.#next.delete(id);
      });
      reaped.push(id);
    }
    return reaped;
  }

  /**
   * D1b — watch the budget, and say something while it is still actionable.
   *
   * `recordedMs` is optional and only improves the answer: with it the budget is
   * expressed as remaining recording time, which is the unit a user in a meeting
   * can actually act on.
   */
  async budget(input: { readonly byteLength?: number; readonly recordedMs?: number } = {}): Promise<CaptureBudget> {
    let usage: number | undefined;
    let quota: number | undefined;
    if (this.#estimate) {
      try {
        const estimate = await this.#estimate();
        usage = estimate.usage;
        quota = estimate.quota;
      } catch {
        // An estimate that throws is an unknown budget, which `evaluateCaptureBudget`
        // already reports as a visible degradation rather than as "fine".
      }
    }
    const rate = input.byteLength !== undefined && input.recordedMs !== undefined
      ? captureRecordingRate(input.byteLength, input.recordedMs)
      : undefined;
    return evaluateCaptureBudget({
      usageBytes: usage,
      quotaBytes: quota,
      persisted: this.#persisted,
      ...(rate === undefined ? {} : { bytesPerMs: rate }),
    });
  }

  async #record(sessionId: string, manifest: CaptureManifest): Promise<CaptureSessionRecord> {
    const chunks = await this.#chunks(sessionId);
    return {
      sessionId,
      startedAt: manifest.startedAt,
      closed: manifest.closed,
      payload: manifest.payload,
      chunks,
      byteLength: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    };
  }

  /** Sorted here, so no backend's listing order can reorder a meeting. */
  async #chunks(sessionId: string): Promise<readonly CaptureChunkRef[]> {
    const chunks = await this.#backend.listChunks(sessionId);
    return chunks.slice().sort((a, b) => a.sequence - b.sequence);
  }

  async #seedSequence(sessionId: string): Promise<number> {
    const chunks = await this.#chunks(sessionId);
    const last = chunks[chunks.length - 1];
    return last ? last.sequence + 1 : 0;
  }

  #serialize<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tail.get(sessionId) ?? Promise.resolve();
    // `then(task, task)` rather than `then(task)`: a chunk that failed to write
    // must not stop the next one from being written, or one transient error
    // silently ends the recording.
    const next = previous.then(task, task);
    const tail: Promise<unknown> = next.then(noop, noop).then(() => {
      // Prune, but only if nothing was queued behind us. `settled()` reads
      // emptiness as "drained", so an entry left behind after the last write
      // would make every later drain wait on a promise that already resolved,
      // and a Map that grows one entry per recording never shrinks.
      if (this.#tail.get(sessionId) === tail) this.#tail.delete(sessionId);
    });
    this.#tail.set(sessionId, tail);
    return next;
  }
}

/**
 * How many times `settled` re-checks the queue before giving up.
 *
 * Four is generous for the case it exists for — the final `ondataavailable`
 * racing `onstop` needs one — and small enough that a runaway producer cannot
 * turn Stop into a hang.
 */
const CAPTURE_DRAIN_PASSES = 4;

function noop(): void {
  /* the queue only needs settlement, never the value or the reason */
}

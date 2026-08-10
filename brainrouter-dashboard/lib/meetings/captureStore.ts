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
 * - **Appends are serialized per session.** `MediaRecorder` fires
 *   `ondataavailable` from an event handler that will not wait for a promise, so
 *   two chunks can be in flight at once. Without a queue they would race for a
 *   sequence number and one would overwrite the other — silently, which is the
 *   whole category of bug this ADR is about.
 * - **A failed write does not consume a sequence.** If the bytes did not land,
 *   the number is still free, so the recording continues without a hole in it.
 *
 * The store never parses `payload`. It is whatever the caller's session model
 * serialized (see `captureStorage.ts` for why that boundary is where it is).
 */
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
 * ADR-035 §5.1 — the recorder's chunk cadence.
 *
 * D1 is explicit that `MediaRecorder` needs an explicit timeslice, because
 * without one it may deliver a single blob at the end and the durable write buys
 * nothing. Twenty seconds is the midpoint of the ADR's 15–30s range and matches
 * the shared default the desktop uses; the constant is restated here rather than
 * imported because the dashboard may not depend on the core package (see
 * `captureStorage.ts`).
 */
export const MEETING_CAPTURE_TIMESLICE_MS = 20_000;

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
   * someone still wants. Use `attach` to continue a session on purpose.
   */
  async begin(input: BeginCaptureInput): Promise<CaptureSessionRecord> {
    const sessionId = assertCaptureSessionId(input.sessionId);
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
  }

  /** Reopen a session found at load — the recovery half of D2. */
  async attach(sessionId: string): Promise<CaptureSessionRecord> {
    const id = assertCaptureSessionId(sessionId);
    const manifest = await this.#backend.readManifest(id);
    if (!manifest) throw new Error(`No meeting capture named ${id} is stored.`);
    this.#next.set(id, await this.#seedSequence(id));
    return this.#record(id, manifest);
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

  /** Replace the caller's serialized session model, and optionally settle it. */
  async setPayload(
    sessionId: string,
    payload: string,
    options: { readonly closed?: boolean } = {},
  ): Promise<CaptureSessionRecord> {
    const id = assertCaptureSessionId(sessionId);
    const manifest = await this.#backend.readManifest(id);
    if (!manifest) throw new Error(`No meeting capture named ${id} is stored.`);
    const next: CaptureManifest = { ...manifest, payload, closed: options.closed ?? manifest.closed };
    await this.#backend.writeManifest(id, next);
    return this.#record(id, next);
  }

  async read(sessionId: string): Promise<CaptureSessionRecord | undefined> {
    const id = assertCaptureSessionId(sessionId);
    const manifest = await this.#backend.readManifest(id);
    return manifest ? this.#record(id, manifest) : undefined;
  }

  /**
   * D1b's destructive test, from the store's side: everything written up to the
   * kill, in the order it was spoken.
   */
  async readAudio(sessionId: string, type = "audio/webm"): Promise<CaptureAudio> {
    const id = assertCaptureSessionId(sessionId);
    const chunks = await this.#chunks(id);
    const parts: Blob[] = [];
    const missing: number[] = [];
    let byteLength = 0;
    for (const chunk of chunks) {
      const blob = await this.#backend.readChunk(id, chunk.sequence);
      if (!blob) {
        missing.push(chunk.sequence);
        continue;
      }
      parts.push(blob);
      byteLength += blob.size;
    }
    return { blob: new Blob(parts, { type }), byteLength, missing };
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

  /**
   * D2 — "a session with audio and no terminal state is offered back".
   *
   * Both halves matter. Without the audio test, a Record cancelled a second
   * later comes back as an offer, and an offer users learn to dismiss protects
   * nobody. Without the terminal test, a meeting someone finished or explicitly
   * threw away comes back, which is worse than noise.
   */
  async resumable(): Promise<readonly CaptureSessionRecord[]> {
    const records = await this.list();
    return records.filter((record) => !record.closed && record.byteLength > 0);
  }

  async delete(sessionId: string): Promise<void> {
    const id = assertCaptureSessionId(sessionId);
    await this.#backend.deleteSession(id);
    this.#next.delete(id);
    this.#tail.delete(id);
  }

  /** Everything the backend holds, including audio whose manifest is gone. */
  async listStoredSessionIds(): Promise<readonly string[]> {
    return this.#backend.listSessionIds();
  }

  /**
   * D6 — stored captures with no session the caller knows about are reaped, and
   * the caller is told which, so the reap can be logged.
   *
   * The caller supplies the known ids because only it can see the session rows;
   * the store's own manifest is not that list.
   */
  async reapOrphans(knownSessionIds: readonly string[]): Promise<readonly string[]> {
    const known = new Set(knownSessionIds);
    const stored = await this.#backend.listSessionIds();
    const reaped: string[] = [];
    for (const id of stored) {
      if (known.has(id)) continue;
      // Deliberately NOT re-validated: this id came from the store's own listing
      // rather than from a caller, and a leftover whose name this model would
      // refuse to mint is precisely the kind of thing D6 asks to be reaped.
      await this.#backend.deleteSession(id);
      this.#next.delete(id);
      this.#tail.delete(id);
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
    this.#tail.set(sessionId, next.then(noop, noop));
    return next;
  }
}

function noop(): void {
  /* the queue only needs settlement, never the value or the reason */
}

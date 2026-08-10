/**
 * ADR-035 D1/D2/D6 — the desktop's meeting capture store.
 *
 * This module owns the only place in the desktop that may write meeting audio:
 * one `0700` directory per capture under the app-data root, holding `0600`
 * segment files and the session record that describes them. Nothing else in the
 * app writes audio, and the renderer cannot — it has no filesystem, which is the
 * point. §1's defect was that the audio for an entire meeting lived in a React
 * ref until Stop, so a crash lost it all; here a chunk is durable the instant
 * `ondataavailable` hands it over.
 *
 * Invariants, each of which a caller could otherwise get wrong quietly:
 *
 * 1. **Bytes first, record second.** `writeSegment` writes the segment file and
 *    the record is only rewritten afterwards, by the transcription supervisor
 *    that owns it (`meetingTranscription.ts`). A crash between the two leaves a
 *    segment file the record does not mention, which the next boot ADOPTS — see
 *    `adoptUnclaimedChunks`; the reverse order would leave a record pointing at
 *    audio that does not exist, and recovery believes the record
 *    (`MeetingSegment.byteLength` is "what the host actually wrote"). The two
 *    halves are separate methods for one reason: under D3 the transcription
 *    queue is the SINGLE WRITER of an open capture's record, so this store must
 *    not edit it beside the queue. Boot is the one moment no queue exists, which
 *    is why the reconciliation lives in `recoverInterrupted` and nowhere else.
 * 2. **The record lives inside the directory it describes.** So a terminal
 *    meeting is a `rm -rf`, not a tombstone that accumulates — D6 asks for a
 *    real deletion, and a store that keeps metadata about deleted audio forever
 *    is the kind of thing that turns into a retention incident.
 * 3. **Writes for one session are serialized.** Two overlapping `append` calls
 *    would both read the same session, and one would silently lose its segment.
 * 4. **A terminal capture owns no bytes.** `finalize`/`discard` delete the
 *    directory, and the boot pass finishes any delete a kill interrupted — see
 *    `recoverInterrupted`. D6 asks for a real deletion, and one that only
 *    happens when the process survives long enough is not one.
 *
 * **Which durability this actually buys, stated rather than implied.** A segment
 * is handed to the kernel and the file is closed; from that moment the bytes
 * survive the PROCESS dying, which is exactly §6's destructive test ("kill the
 * application — not close, kill"). It is NOT a promise about a power cut or a
 * kernel panic: there is no `fsync` on this path, so a chunk written in the last
 * moments before the machine loses power may still be in the page cache. Adding
 * a flush would put a device-latency round trip between every segment and the
 * next on the recording hot path, and §5 asks for that kind of thing to be
 * measured rather than guessed — so this module states the guarantee it has
 * instead of the one it would like (ADR-028: say which state you are in).
 *
 * The session shape, the transitions and the recovery predicate all come from
 * `@kinqs/brainrouter-core/meetings` — D1b's "only the write target is
 * host-specific". This file is the write target and nothing more.
 *
 * It deliberately does not import `electron`: the IPC surface lives in
 * `meetingCaptureBridge.ts` so the store itself can be unit-tested against a
 * temporary directory, which is where the `0700`/`0600` guarantee is actually
 * checked.
 */
import fs, { type Dirent } from 'node:fs';
import path from 'node:path';
import {
  appendSegment,
  capturedByteLength,
  createCaptureSession,
  discardCapture,
  finalizeCapture,
  isMeetingSessionId,
  isTerminalCaptureStatus,
  orphanCaptureIds,
  recoverCaptureSession,
  resumableSessions,
  resumeCapture,
  stopCapture,
  summarizeRecovery,
  DEFAULT_MEETING_SEGMENT_MS,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
  type MeetingCaptureTemplate,
  type MeetingRecoverySummary,
} from '@kinqs/brainrouter-core/meetings';

/** Sub-directory of the Electron `userData` root. Open question 2 — an existing rooted location, not a new one. */
export const MEETING_CAPTURE_DIRECTORY = 'meeting-captures';

const RECORD_FILE = 'session.json';
const SEGMENT_PREFIX = 'segment-';
/**
 * A fixed suffix rather than one derived from the recorder's MIME type: the
 * extension is only a hint for a human browsing the directory, and the truthful
 * type is stored in the record and returned by `read`. Deriving a filename from
 * a renderer-supplied string is a path-injection surface for no benefit.
 */
const SEGMENT_SUFFIX = '.webm';
const SEGMENT_DIGITS = 5;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_CONTENT_TYPE = 'audio/webm';

export interface BeginCaptureInput {
  readonly scope: MeetingCaptureScope;
  readonly title?: string;
  readonly template?: MeetingCaptureTemplate;
  readonly language?: string;
  /** The recorder's own MIME type, kept so `read` can describe the bytes truthfully. */
  readonly contentType?: string;
}

export interface CapturedAudio {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** What one boot pass corrected, so the reap D6 asks for can be logged. */
export interface MeetingCaptureRecoveryReport {
  /** Sessions a crash left non-terminal, now corrected and offerable again. */
  readonly recovered: readonly string[];
  /**
   * Sessions whose record was extended to claim a durable chunk the kill landed
   * before it could mention. Reported separately from `recovered` because this
   * is audio that would otherwise have been thrown away, and §6 judges this
   * feature on exactly those seconds — worth being able to see in a log.
   */
  readonly adopted: readonly string[];
  /**
   * Capture directories deleted by this pass, for the three reasons a directory
   * can hold nothing a session will ever be offered: no readable record at all,
   * a record that is already terminal because a kill landed between `close`'s
   * write and its delete, and a Record that died before its first chunk reached
   * the disk (a record with no audio under it at all).
   */
  readonly reaped: readonly string[];
}

/**
 * The on-disk record. `contentType` is carried beside the shared session rather
 * than inside it because it is a property of THIS host's recorder, not of what a
 * meeting is — the dashboard's OPFS blobs answer the same question differently.
 */
interface StoredCapture {
  readonly version: 1;
  readonly contentType: string;
  readonly session: MeetingCaptureSession;
}

function segmentName(index: number): string {
  return `${SEGMENT_PREFIX}${String(index).padStart(SEGMENT_DIGITS, '0')}${SEGMENT_SUFFIX}`;
}

function segmentIndex(entry: string): number | null {
  if (!entry.startsWith(SEGMENT_PREFIX) || !entry.endsWith(SEGMENT_SUFFIX)) return null;
  const digits = entry.slice(SEGMENT_PREFIX.length, entry.length - SEGMENT_SUFFIX.length);
  if (!/^\d+$/.test(digits)) return null;
  return Number.parseInt(digits, 10);
}

/**
 * The size of a segment file, or 0 when it cannot be measured.
 *
 * 0 is the right answer for both failures a boot pass can hit here — the file
 * vanished, or it cannot be stat'ed — because both mean "do not claim this as
 * audio", and the shared model refuses a zero-byte segment anyway.
 */
async function fileSize(target: string): Promise<number> {
  try { return (await fs.promises.stat(target)).size; } catch { return 0; }
}

/** Windows has no POSIX modes; the security property is a POSIX one, so a failure there is not an error. */
async function chmodQuiet(target: string, mode: number): Promise<void> {
  try { await fs.promises.chmod(target, mode); } catch { /* Windows */ }
}

/**
 * `O_EXCL` so a segment index is never written twice, `O_NOFOLLOW` so the path
 * cannot be redirected through a symlink someone dropped in the capture
 * directory — the same shape the browser upload staging uses for the same
 * reason. The mode is set at creation AND after, because `open`'s mode argument
 * is masked by the process umask.
 *
 * The byte count is CHECKED rather than assumed. `write` resolves on a short
 * write — the ENOSPC boundary is the realistic case, and it does not throw — so
 * a caller that trusted it would record `bytes.byteLength` for a segment the
 * disk only partly took, and `types.ts` promises the opposite: `byteLength` is
 * what the host actually wrote. Recovery believes that number, so an optimistic
 * one is a session that claims audio it does not have.
 */
async function writeSegmentFile(file: string, bytes: Uint8Array): Promise<number> {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fs.promises.open(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
    FILE_MODE,
  );
  try {
    await handle.chmod(FILE_MODE).catch(() => undefined);
    const { bytesWritten } = await handle.write(bytes);
    // Closed inside the `try` on purpose: a write that filled the filesystem can
    // report its error at close, and a segment whose close failed is not one to
    // record as written.
    await handle.close();
    if (bytesWritten !== bytes.byteLength) {
      throw new Error(`Only ${bytesWritten} of ${bytes.byteLength} bytes of this recording reached the disk.`);
    }
    return bytesWritten;
  } catch (caught) {
    await handle.close().catch(() => undefined);
    // The index has to stay free: `O_EXCL` would refuse the retry, and a partial
    // file no record mentions is a torn tail the next boot has to clean up.
    await fs.promises.rm(file, { force: true }).catch(() => undefined);
    throw caught;
  }
}

function parseStored(raw: string, id: string): StoredCapture | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<StoredCapture>;
  const session = record.session;
  if (!session || typeof session !== 'object') return null;
  // The id must match the directory it was found in: a record claiming another
  // session would make every path this store derives from `session.id` point
  // somewhere other than where the audio actually is.
  if (session.id !== id || !Array.isArray(session.segments)) return null;
  return {
    version: 1,
    contentType: typeof record.contentType === 'string' && record.contentType ? record.contentType : DEFAULT_CONTENT_TYPE,
    session,
  };
}

export class MeetingCaptureStore {
  private readonly root: string;

  /**
   * When this store opened — for the real app, launch.
   *
   * The boot pass reaps a record with no audio under it, and a capture the
   * CURRENT process created moments ago is exactly that for the seconds before
   * its first chunk lands. Comparing `startedAt` against this instant is what
   * keeps the reap to captures a PREVIOUS run left behind.
   */
  private readonly openedAt = new Date().toISOString();

  /** Per-session write chain — invariant 3. Cleared once a session's tail settles. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(userDataPath: string) {
    this.root = path.join(userDataPath, MEETING_CAPTURE_DIRECTORY);
  }

  /**
   * D2 — pressing Record creates the meeting, and the directory it will be
   * appended to, BEFORE any audio exists. Everything after is an append to
   * something already on disk, which is what makes a crash recoverable rather
   * than merely detectable.
   */
  async begin(input: BeginCaptureInput): Promise<MeetingCaptureSession> {
    const session = createCaptureSession({
      scope: input.scope,
      ...(input.title ? { title: input.title } : {}),
      ...(input.template ? { template: input.template } : {}),
      ...(input.language ? { language: input.language } : {}),
    });
    await fs.promises.mkdir(this.root, { recursive: true, mode: DIRECTORY_MODE });
    await chmodQuiet(this.root, DIRECTORY_MODE);
    const directory = this.directory(session.id);
    await fs.promises.mkdir(directory, { mode: DIRECTORY_MODE });
    await chmodQuiet(directory, DIRECTORY_MODE);
    await this.write(session, input.contentType?.trim() || DEFAULT_CONTENT_TYPE);
    return session;
  }

  /**
   * D1 — a chunk of audio, durable before it is anything else, and NOTHING else.
   *
   * The session record is deliberately untouched here: the supervisor records
   * the segment through the queue's `apply` the moment this resolves, because
   * D3's queue is the single writer of an open capture and a store that also
   * edited the record would be the second one. Splitting the write is what lets
   * "bytes first, record second" hold without two writers.
   *
   * The return value is what the DISK TOOK, not what it was handed —
   * `types.ts` makes that distinction load-bearing and recovery believes the
   * number, so the caller must record this rather than `bytes.byteLength`.
   */
  async writeSegment(id: string, index: number, bytes: Uint8Array): Promise<number> {
    return this.serialize(id, async () => {
      // The capture has to exist first: a segment file in a directory with no
      // record is precisely the orphan the boot pass deletes, so writing one
      // would be writing audio we have already decided to throw away.
      await this.load(id);
      return await writeSegmentFile(path.join(this.directory(id), segmentName(index)), bytes);
    });
  }

  /**
   * D3 — one chunk back off disk, or `null` when that chunk is gone.
   *
   * This is the `readChunk` half of the shared `createSegmentAudioReader`, NOT
   * the queue's `readSegment` port: what the endpoint is posted is a chunk with
   * the recording's container header put back in front of it, and that framing
   * is shared logic in `@kinqs/brainrouter-core/meetings` rather than something
   * this host decides. Handing the raw file straight to the queue is what made
   * the desktop transcribe segment 0 and nothing else.
   *
   * `null` rather than a throw for a missing file, because that is the word the
   * shared reader understands: it becomes a stated gap charged to the retry
   * bound (D5) instead of a retry forever against a store with nothing to give.
   * Any OTHER failure — a permission problem, a bad descriptor — is a fault
   * worth surfacing, so it is rethrown rather than reported as missing audio.
   */
  async readSegment(id: string, index: number): Promise<Uint8Array | null> {
    try {
      const buffer = await fs.promises.readFile(path.join(this.directory(id), segmentName(index)));
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
      throw caught;
    }
  }

  /**
   * The transcription queue's `persist` port — the record, on the same
   * per-session chain every other write uses.
   *
   * It writes only for a capture that is still on disk, and never recreates one:
   * D6 deletes a finalized or discarded meeting's directory, and a persist that
   * rebuilt it would resurrect exactly what the user asked us to forget.
   */
  async persist(session: MeetingCaptureSession): Promise<MeetingCaptureSession> {
    return this.serialize(session.id, async () => {
      const stored = await this.load(session.id);
      await this.write(session, stored.contentType);
      return session;
    });
  }

  async session(id: string): Promise<MeetingCaptureSession> {
    return (await this.load(id)).session;
  }

  /** The record together with the recorder MIME that describes its bytes. */
  async stored(id: string): Promise<{ session: MeetingCaptureSession; contentType: string }> {
    const stored = await this.load(id);
    return { session: stored.session, contentType: stored.contentType };
  }

  /**
   * The captured audio, segments concatenated in index order — which is the
   * original recorder stream, because a `MediaRecorder` timeslice splits one
   * container rather than producing many.
   */
  async read(id: string): Promise<CapturedAudio> {
    const stored = await this.load(id);
    const directory = this.directory(id);
    const parts: Buffer[] = [];
    for (const segment of stored.session.segments) {
      parts.push(await fs.promises.readFile(path.join(directory, segmentName(segment.index))));
    }
    // Handed back as a plain `Uint8Array` view over the concatenation rather
    // than a `Buffer`: that is what structured clone delivers to the renderer,
    // so the declared type should not promise a Node-only subclass.
    const merged = Buffer.concat(parts);
    return { bytes: new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength), contentType: stored.contentType };
  }

  /** D6 — the user accepted the meeting, so the audio is released. */
  async finalize(id: string): Promise<void> {
    await this.close(id, finalizeCapture);
  }

  /** D6 — an explicit discard, and a real deletion rather than a hidden one. */
  async discard(id: string): Promise<void> {
    await this.close(id, discardCapture);
  }

  /**
   * D2 — what this launch offers back: a session with audio and no terminal
   * state, scoped to the org now in context so a meeting started under one org
   * is never re-attached under another (open question 5).
   */
  async resumable(scope?: MeetingCaptureScope): Promise<MeetingRecoverySummary[]> {
    const sessions: MeetingCaptureSession[] = [];
    for (const id of await this.storedIds()) {
      const stored = await this.loadQuietly(id);
      if (stored) sessions.push(stored.session);
    }
    return resumableSessions(sessions, scope ? { scope } : {}).map(summarizeRecovery);
  }

  /**
   * The boot pass, run once before any recording starts.
   *
   * Four truths a crash leaves behind and all are corrected rather than
   * displayed: a session still marked `recording` is not, a chunk that reached
   * the disk before the record could claim it is real audio and is adopted, a
   * capture whose record is already terminal is audio the user finalized or
   * explicitly threw away that outlived the delete meant to remove it, and a
   * Record that died before its first chunk landed is a directory holding
   * nothing anyone will ever be offered. Directories with no readable record are
   * orphans and are reaped too (D6).
   */
  async recoverInterrupted(): Promise<MeetingCaptureRecoveryReport> {
    const ids = await this.storedIds();
    const sessions: MeetingCaptureSession[] = [];
    const recovered: string[] = [];
    const adopted: string[] = [];
    const reaped: string[] = [];
    for (const id of ids) {
      const stored = await this.loadQuietly(id);
      if (!stored) continue;
      if (isTerminalCaptureStatus(stored.session.status)) {
        // `close` writes the terminal status BEFORE deleting the audio, so a
        // kill in between leaves the directory of a meeting the user accepted or
        // discarded. No other path retries that delete, and because the record
        // IS readable the orphan rule below would never claim it either — so
        // this is where a discarded meeting's audio stops existing. Deleting on
        // sight is safe precisely because the status is terminal: nothing will
        // ever be appended to it, offered back, or read again.
        await fs.promises.rm(this.directory(id), { recursive: true, force: true });
        reaped.push(id);
        continue;
      }
      const claimed = await this.adoptUnclaimedChunks(id, stored.session);
      if (claimed.segments.length > stored.session.segments.length) adopted.push(id);
      const session = recoverCaptureSession(claimed);
      // D6/D2 — a Record the user cancelled, or that died before its first chunk
      // reached the disk, leaves a record with no audio under it. `resumable`
      // will never offer it (no bytes) and the orphan rule below will never
      // claim it (it HAS a record), so without this it is a directory that
      // outlives every pass forever. The `openedAt` guard is what keeps this
      // from reaping a capture the CURRENT launch has just created and not yet
      // written a chunk for — that session is seconds old and about to have one.
      if (capturedByteLength(session) === 0 && session.startedAt < this.openedAt) {
        await fs.promises.rm(this.directory(id), { recursive: true, force: true });
        reaped.push(id);
        continue;
      }
      sessions.push(session);
      const changed = session.status !== stored.session.status
        || session.segments.length !== stored.session.segments.length
        || session.segments.some((segment, index) => segment !== stored.session.segments[index]);
      if (!changed) continue;
      await this.write(session, stored.contentType);
      recovered.push(id);
    }
    // The ones already deleted above are excluded here rather than being deleted
    // and counted twice.
    for (const id of orphanCaptureIds(ids.filter((entry) => !reaped.includes(entry)), sessions)) {
      await fs.promises.rm(this.directory(id), { recursive: true, force: true });
      reaped.push(id);
    }
    return { recovered, adopted, reaped };
  }

  private directory(id: string): string {
    // The id names a directory, so it is validated by the shared model before it
    // is ever joined onto a path — a `..` here would be a traversal bug.
    if (!isMeetingSessionId(id)) throw new Error('That is not a meeting capture id.');
    return path.join(this.root, id);
  }

  private async load(id: string): Promise<StoredCapture> {
    const stored = await this.loadQuietly(id);
    if (!stored) throw new Error('That meeting capture is no longer on this device.');
    return stored;
  }

  private async loadQuietly(id: string): Promise<StoredCapture | null> {
    // The id is validated OUTSIDE the try: "this is not a capture id" is a
    // programming error worth surfacing, while "there is no such record" is the
    // ordinary answer this method exists to give.
    const file = path.join(this.directory(id), RECORD_FILE);
    let raw: string;
    try { raw = await fs.promises.readFile(file, 'utf8'); }
    catch { return null; }
    return parseStored(raw, id);
  }

  private async write(session: MeetingCaptureSession, contentType: string): Promise<void> {
    const file = path.join(this.directory(session.id), RECORD_FILE);
    const temporary = `${file}.${process.pid}.tmp`;
    const payload: StoredCapture = { version: 1, contentType, session };
    // Temp-then-rename so a crash mid-write leaves the previous record intact
    // rather than a truncated one, which would read as "no such capture".
    await fs.promises.writeFile(temporary, `${JSON.stringify(payload)}\n`, { mode: FILE_MODE });
    await chmodQuiet(temporary, FILE_MODE);
    await fs.promises.rename(temporary, file);
  }

  private async close(
    id: string,
    transition: (session: MeetingCaptureSession) => MeetingCaptureSession,
  ): Promise<void> {
    await this.serialize(id, async () => {
      const stored = await this.loadQuietly(id);
      // The terminal status is written BEFORE the delete, so a crash between the
      // two leaves a record that recovery will not offer again. Offering back a
      // meeting the user threw away is worse than losing the reap.
      if (stored && !isTerminalCaptureStatus(stored.session.status)) {
        await this.write(transition(stored.session), stored.contentType);
      }
      await fs.promises.rm(this.directory(id), { recursive: true, force: true });
    });
  }

  /**
   * Believe the chunks.
   *
   * D1 writes the bytes and THEN the record, so the last thing a kill can
   * interrupt is the record — leaving a segment file the session does not
   * mention. Deleting those files was the obvious reading of "torn tail" and it
   * is the wrong one: a chunk at index `segments.length` was fully written and
   * closed, and throwing it away discards up to twenty seconds of real audio at
   * exactly the moment §6 asks for "the audio up to the kill". The record is the
   * stale artifact here, not the file. So the record is extended to claim what
   * the disk actually holds — the same policy the dashboard reaches by the same
   * argument (`capturePayload.ts`, `adoptChunks`).
   *
   * The rule for what may be believed, because "any leftover file" is too
   * generous:
   *
   * - **Contiguous from the end of the record.** A segment's index IS the chunk
   *   the queue reads audio from, so bridging a hole would transcribe segment
   *   N+1 from segment N+2's audio — text that looks right and is wrong, which
   *   is worse than an unclaimed chunk. The walk stops at the first missing
   *   index and everything past it is deleted.
   * - **Non-empty.** `open` can succeed and the process die before the write, and
   *   the shared model refuses a zero-byte segment anyway.
   *
   * Only the HIGHEST-indexed file can be a genuinely torn write, because
   * `writeSegment` serializes per session and only resolves after `close`. It is
   * adopted regardless: a truncated tail is at worst one segment the endpoint
   * cannot decode, which D5 turns into a stated gap with a retry — while
   * deleting it is silent loss, which is the failure this ADR exists to end.
   *
   * Durations are the recorder's nominal timeslice: the measured elapsed time
   * died with the process that measured it, and a gap marker needs a range that
   * is monotonic and about right, not one invented to look precise.
   */
  private async adoptUnclaimedChunks(
    id: string,
    session: MeetingCaptureSession,
  ): Promise<MeetingCaptureSession> {
    const directory = this.directory(id);
    let entries: string[];
    try { entries = await fs.promises.readdir(directory); } catch { return session; }
    const unclaimed = new Map<number, string>();
    for (const entry of entries) {
      const index = segmentIndex(entry);
      if (index === null || index < session.segments.length) continue;
      unclaimed.set(index, entry);
    }
    if (!unclaimed.size) return session;

    const believable = new Map<number, number>();
    for (let index = session.segments.length; unclaimed.has(index); index += 1) {
      const bytes = await fileSize(path.join(directory, unclaimed.get(index)!));
      if (bytes <= 0) break;
      believable.set(index, bytes);
    }
    for (const [index, entry] of unclaimed) {
      if (believable.has(index)) continue;
      await fs.promises.rm(path.join(directory, entry), { force: true });
    }
    if (!believable.size) return session;

    // `appendSegment` only accepts a recording session, so a cleanly stopped one
    // is resumed for the append and stopped again with its ORIGINAL timestamp —
    // the recording did not restart, and rewriting `stoppedAt` would misreport
    // when it ended.
    const stoppedAt = session.status === 'stopped' ? session.stoppedAt : undefined;
    let next = session.status === 'recording' ? session : resumeCapture(session);
    for (const byteLength of believable.values()) {
      next = appendSegment(next, { byteLength, durationMs: DEFAULT_MEETING_SEGMENT_MS });
    }
    return session.status === 'recording' ? next : stopCapture(next, stoppedAt);
  }

  private async storedIds(): Promise<string[]> {
    let entries: Dirent[];
    try { entries = await fs.promises.readdir(this.root, { withFileTypes: true }); } catch { return []; }
    return entries.filter((entry) => entry.isDirectory() && isMeetingSessionId(entry.name)).map((entry) => entry.name);
  }

  private serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    // The stored tail swallows rejections so one failed append cannot poison
    // every later one; the caller still sees its own error from `next`.
    const tail = next.then(() => undefined, () => undefined);
    this.chains.set(id, tail);
    void tail.then(() => { if (this.chains.get(id) === tail) this.chains.delete(id); });
    return next;
  }
}

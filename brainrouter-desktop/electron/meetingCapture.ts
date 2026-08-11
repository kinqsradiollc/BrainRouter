/**
 * ADR-035 D1/D2/D6/D9 — the desktop's meeting capture store.
 *
 * This module owns the only place in the desktop that may write meeting audio:
 * one `0700` directory per capture under the app-data root, holding `0600`
 * chunk files and the session record that describes them. Nothing else in the
 * app writes audio, and the renderer cannot — it has no filesystem, which is the
 * point. §1's defect was that the audio for an entire meeting lived in a React
 * ref until Stop, so a crash lost it all; here a chunk is durable the instant
 * `ondataavailable` hands it over.
 *
 * Invariants, each of which a caller could otherwise get wrong quietly:
 *
 * 1. **Bytes first, record second.** `writeSegment` writes the durability chunk and
 *    the record is only rewritten afterwards, by the transcription supervisor
 *    that owns it (`meetingTranscription.ts`). A crash between the two leaves a
 *    chunk file the record does not mention, which the next boot ADOPTS — see
 *    `claimStoredChunks`; the reverse order would leave a record pointing at
 *    audio that does not exist, and recovery believes the record
 *    (`MeetingChunk.byteLength` is "what the host actually wrote"). The two
 *    halves are separate methods for one reason: under D3 the transcription
 *    queue is the SINGLE WRITER of an open capture's record, so this store must
 *    not edit it beside the queue. Boot is the one moment no queue exists, which
 *    is why the reconciliation lives in `recoverInterrupted` and nowhere else.
 * 2. **The record lives inside the directory it describes.** So a terminal
 *    meeting is a `rm -rf`, not a tombstone that accumulates — D6 asks for a
 *    real deletion, and a store that keeps metadata about deleted audio forever
 *    is the kind of thing that turns into a retention incident.
 * 3. **Writes for one session are serialized.** Two overlapping `append` calls
 *    would both read the same session, and one would silently lose its
 *    chunk-ledger update.
 * 4. **A terminal capture owns no bytes.** `finalize`/`discard` delete the
 *    directory, and the boot pass finishes any delete a kill interrupted — see
 *    `recoverInterrupted`. D6 asks for a real deletion, and one that only
 *    happens when the process survives long enough is not one.
 * 5. **This store does not know who is recording, and does not guess.** Liveness
 *    is a question about the PROCESS — which window has a microphone open — and
 *    the process knows it exactly: `MeetingTranscriptionSupervisor` is created
 *    once beside this store and holds one entry per live capture. So the offer,
 *    the reap and the two destructive transitions ask IT (`isWriting` below is
 *    how the boot pass does), and this module keeps no second answer of its own.
 *    It previously read a lease off `session.writer` — a heartbeat plus a
 *    staleness threshold — which was a timing heuristic standing in for a fact
 *    main already had, and it failed in the direction that costs a meeting: a
 *    window RELOAD left main heartbeating for a renderer that no longer existed,
 *    so the recording was refused to every window for ever. A lease found in a
 *    record an older build wrote is dropped as the record is parsed (see
 *    `parseStored`), so no such stamp survives a single read of this store.
 *
 * **Which durability this actually buys, stated rather than implied.** A
 * durability chunk is handed to the kernel and the file is closed; from that moment the bytes
 * survive the PROCESS dying, which is exactly §6's destructive test ("kill the
 * application — not close, kill"). It is NOT a promise about a power cut or a
 * kernel panic: there is no `fsync` on this path, so a chunk written in the last
 * moments before the machine loses power may still be in the page cache. Adding
 * a flush would put a device-latency round trip between every chunk and the
 * next on the recording hot path, and §5 asks for that kind of thing to be
 * measured rather than guessed — so this module states the guarantee it has
 * instead of the one it would like (ADR-028: say which state you are in).
 *
 * The session shape, the transitions and the recovery predicate all come from
 * `@kinqs/brainrouter-core/meetings` — D1b's "only the write target is
 * host-specific". This file is the write target and nothing more.
 *
 * It deliberately does not import `electron`: the channels live in
 * `meetingCaptureChannels.ts` and Electron itself in `meetingCaptureBridge.ts`,
 * so the store can be unit-tested against a temporary directory — which is where
 * the `0700`/`0600` guarantee is actually checked.
 */
import fs, { type Dirent } from 'node:fs';
import path from 'node:path';
import {
  adoptCaptureChunks,
  captureChunks,
  capturedByteLength,
  createCaptureSession,
  discardCapture,
  finalizeCapture,
  isMeetingCaptureSession,
  isMeetingSessionId,
  isTerminalCaptureStatus,
  nextChunkSequence,
  orphanCaptureIds,
  recoverCaptureSession,
  resumableSessions,
  summarizeRecovery,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
  type MeetingCaptureTemplate,
  type MeetingRecoverySummary,
  type MeetingStoredChunk,
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
/** Over 34 days at the 3s cadence; bounds corrupt sparse filenames before allocating a missing list. */
const MAX_PLAYBACK_CHUNK_COUNT = 1_000_000;

export interface BeginCaptureInput {
  readonly scope: MeetingCaptureScope;
  readonly title?: string;
  readonly template?: MeetingCaptureTemplate;
  readonly language?: string;
  /** The recorder's own MIME type, kept so `read` can describe the bytes truthfully. */
  readonly contentType?: string;
}

/** What one boot pass must be told before it corrects anything — see `recoverInterrupted`. */
export interface MeetingCaptureRecoveryOptions {
  /**
   * D6 — is a window in this process recording into that capture right now?
   *
   * The boot pass REWRITES records, ADOPTS chunk files and DELETES directories,
   * and every one of those is wrong for a live capture: measured, a second pass
   * over a recording rewrote it to `stopped` and adopted the chunk the recorder
   * had just written, after which every remaining chunk failed `EEXIST` for
   * ever, because an in-memory chunk ledger can never advance past a collision.
   * The rest of that meeting was lost with no self-heal.
   *
   * Defaults to "nobody", which is the truth at the one moment this actually
   * runs — registration, before any window can press Record — and a lie at any
   * other, which is why the caller can say otherwise.
   */
  readonly isWriting?: (id: string) => boolean;
}

export interface CapturedAudio {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /**
   * §6/D5 — absent or unreadable durability sequences through the last ledger
   * or physical chunk. A physical file after a hole extends that range: its
   * bytes play, while the hole is still stated here.
   *
   * Stated rather than thrown, for the same reason a failed segment is a marked
   * gap and not an omission: an hour of meeting is fifty-nine other minutes that
   * are right here, and refusing all of them because one file is unreadable is
   * the silent-total-loss failure this ADR exists to end, wearing an errno.
   */
  readonly missing: readonly number[];
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
   * can hold nothing a session will ever be offered: no record file at all,
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

/** A parsed record may be a bounded salvage that boot recovery must rewrite. */
interface LoadedCapture extends StoredCapture {
  readonly repaired: boolean;
}

type RecoveryCaptureRecord =
  | { readonly kind: 'loaded'; readonly stored: LoadedCapture }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' };

const TEMPLATES: readonly MeetingCaptureTemplate[] = ['general', 'standup', 'one-on-one', 'retrospective'];
const MAX_TITLE_LENGTH = 180;
const MAX_SCOPE_LENGTH = 128;
const MAX_LANGUAGE_LENGTH = 35;
const MAX_CONTENT_TYPE_LENGTH = 255;

function segmentName(index: number): string {
  return `${SEGMENT_PREFIX}${String(index).padStart(SEGMENT_DIGITS, '0')}${SEGMENT_SUFFIX}`;
}

function segmentIndex(entry: string): number | null {
  if (!entry.startsWith(SEGMENT_PREFIX) || !entry.endsWith(SEGMENT_SUFFIX)) return null;
  const digits = entry.slice(SEGMENT_PREFIX.length, entry.length - SEGMENT_SUFFIX.length);
  if (!/^\d+$/.test(digits)) return null;
  const sequence = Number.parseInt(digits, 10);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

/**
 * The size of a chunk file, or 0 when it cannot be measured.
 *
 * 0 is the right answer for both failures a boot pass can hit here — the file
 * vanished, or it cannot be stat'ed — because both mean "do not claim this as
 * audio", and the shared model refuses a zero-byte chunk anyway.
 */
async function fileSize(target: string): Promise<number> {
  try { return (await fs.promises.stat(target)).size; } catch { return 0; }
}

function isMissingPath(caught: unknown): boolean {
  return Boolean(caught && typeof caught === 'object' && 'code' in caught && caught.code === 'ENOENT');
}

/** Windows has no POSIX modes; the security property is a POSIX one, so a failure there is not an error. */
async function chmodQuiet(target: string, mode: number): Promise<void> {
  try { await fs.promises.chmod(target, mode); } catch { /* Windows */ }
}

/**
 * `O_EXCL` so a chunk sequence is never written twice, `O_NOFOLLOW` so the path
 * cannot be redirected through a symlink someone dropped in the capture
 * directory — the same shape the browser upload staging uses for the same
 * reason. The mode is set at creation AND after, because `open`'s mode argument
 * is masked by the process umask.
 *
 * The byte count is CHECKED rather than assumed. `write` resolves on a short
 * write — the ENOSPC boundary is the realistic case, and it does not throw — so
 * a caller that trusted it would record `bytes.byteLength` for a chunk the
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
    // report its error at close, and a chunk whose close failed is not one to
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

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.slice(0, maximum);
}

function boundedNullable(value: unknown): string | null {
  return boundedText(value, MAX_SCOPE_LENGTH) ?? null;
}

function safeStartedAt(value: unknown): string {
  const raw = boundedText(value, 64);
  if (!raw) return new Date(0).toISOString();
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date(0).toISOString();
}

/**
 * Refuse malformed persisted references without turning corruption into loss.
 *
 * A bad manifest is not authority to delete its audio. Recovery starts again
 * from bounded descriptive metadata and an EMPTY model, then adopts what the
 * filesystem can actually prove is there. Presence of the raw `chunks` member
 * is retained even when its contents are untrusted: it distinguishes current
 * short durability chunks from legacy one-file units during adoption.
 */
function salvageSession(
  raw: Record<string, unknown>,
  id: string,
  current: boolean,
  inheritMetadata: boolean,
): MeetingCaptureSession {
  const metadata: Record<string, unknown> = inheritMetadata ? raw : {};
  const rawScope = metadata.scope && typeof metadata.scope === 'object'
    ? metadata.scope as Record<string, unknown>
    : {};
  const template = boundedText(metadata.template, 32);
  const fresh = createCaptureSession({
    id,
    startedAt: safeStartedAt(metadata.startedAt),
    scope: {
      orgId: boundedNullable(rawScope.orgId),
      workspaceId: boundedNullable(rawScope.workspaceId),
    },
    title: boundedText(metadata.title, MAX_TITLE_LENGTH) ?? 'Recovered meeting',
    ...(template && TEMPLATES.includes(template as MeetingCaptureTemplate)
      ? { template: template as MeetingCaptureTemplate }
      : {}),
    ...(boundedText(metadata.language, MAX_LANGUAGE_LENGTH)
      ? { language: boundedText(metadata.language, MAX_LANGUAGE_LENGTH)! }
      : {}),
  });
  if (current) return fresh;
  const { chunks: _currentLedger, ...legacy } = fresh;
  return legacy;
}

function parseStored(raw: string, id: string): LoadedCapture | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<StoredCapture>;
  const session = record.session;
  if (!session || typeof session !== 'object') return null;
  const rawSession = session as unknown as Record<string, unknown>;
  const current = Object.prototype.hasOwnProperty.call(rawSession, 'chunks');
  // A lease an older build wrote is READ AND DROPPED here — the one place every
  // read of this store passes through. `recoverCaptureSession` drops it too, but
  // only for a session the boot pass rewrites: a capture a clean quit left
  // `stopped` is not changed by that pass, so without this the dead field rode
  // every later `{...session}` back onto the disk for the rest of the meeting's
  // life. Nothing reads it — the shape is gone from the shared model, and
  // liveness on this host is the supervisor's per-process writer map (invariant
  // 5) — so carrying it is retention with no purpose, and the name of a window
  // that no longer exists is exactly the thing this round removed. Cast because
  // a session no longer HAS the field; what is read here is what an older build
  // left on the device.
  const { writer: _retired, ...carried } = rawSession;
  const contentType = boundedText(record.contentType, MAX_CONTENT_TYPE_LENGTH) ?? DEFAULT_CONTENT_TYPE;
  if (carried.id !== id || !isMeetingCaptureSession(carried)) {
    return {
      version: 1,
      contentType,
      // A mismatched id means this metadata describes another capture. Keep the
      // directory id and its physical-format signal, but inherit no tenant,
      // title or language from a record that does not belong to it.
      session: salvageSession(rawSession, id, current, rawSession.id === id),
      repaired: true,
    };
  }
  return {
    version: 1,
    contentType,
    session: carried,
    repaired: false,
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
   * The session record is deliberately untouched here: after this resolves, the
   * supervisor records the chunk in the ledger and seals any due transcription
   * units through the queue's `apply`. D3's queue is the single writer of an
   * open capture, and a store that also edited the record would be the second
   * one. Splitting the write is what lets "bytes first, record second" hold
   * without two writers.
   *
   * The return value is what the DISK TOOK, not what it was handed —
   * `types.ts` makes that distinction load-bearing and recovery believes the
   * number, so the caller must record this rather than `bytes.byteLength`.
   */
  async writeSegment(id: string, sequence: number, bytes: Uint8Array): Promise<number> {
    return this.serialize(id, async () => {
      // The capture has to exist first: a chunk file in a directory with no
      // record is precisely the orphan the boot pass deletes, so writing one
      // would be writing audio we have already decided to throw away.
      await this.load(id);
      return await writeSegmentFile(path.join(this.directory(id), segmentName(sequence)), bytes);
    });
  }

  /**
   * D3 — one chunk back off disk, or `null` when that chunk is gone.
   *
   * This is the `readChunk` half of the shared `createSegmentAudioReader`, NOT
   * the queue's `readSegment` port: what the endpoint is posted is a
   * transcription unit assembled from every referenced durability chunk, with
   * the recording's initialization header put back in front. That framing is
   * shared logic in `@kinqs/brainrouter-core/meetings` rather than something
   * this host decides. Handing one raw file straight to the queue is what made
   * the desktop transcribe only the first chunk of a unit.
   *
   * `null` rather than a throw, because that is the word the shared reader
   * understands: it becomes a stated gap charged to the retry bound (D5)
   * instead of a retry forever against a store with nothing to give.
   *
   * **For every failure, not only `ENOENT`.** Narrowing to "the file is gone"
   * read as a principle — a permission problem is a fault worth surfacing —
   * and in practice it was the same silent total loss wearing a different
   * errno. Measured: a deleted file plays and is reported `missing: [1]`; the
   * same file at mode `000` threw `EACCES` and the same path replaced by a
   * directory threw `EISDIR`, and each of those took `read` down with it, so
   * fifty-nine other minutes that were sitting right there became unreachable
   * and the user was shown an errno for a recording whose byte count the
   * recovery card was still advertising. Unreadable is unreadable, whatever
   * the reason; D5's answer to unreadable audio is a stated gap.
   */
  async readSegment(id: string, sequence: number): Promise<Uint8Array | null> {
    // Built OUTSIDE the try, like `loadQuietly`'s: "this is not a capture id" is
    // a programming error worth surfacing, not an unreadable durability chunk.
    const file = path.join(this.directory(id), segmentName(sequence));
    try {
      const buffer = await fs.promises.readFile(file);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch {
      return null;
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

  /** The record together with the recorder MIME that describes its bytes. */
  async stored(id: string): Promise<{ session: MeetingCaptureSession; contentType: string }> {
    const stored = await this.load(id);
    return { session: stored.session, contentType: stored.contentType };
  }

  /**
   * The captured audio, every readable durable chunk concatenated in physical
   * sequence order — which is the original recorder stream, because a
   * `MediaRecorder` timeslice splits one container rather than producing many.
   *
   * A chunk the disk cannot give back is REPORTED, not thrown. `readSegment`
   * already draws that line for transcription — a missing file is `null` and
   * becomes a stated gap — and playback needs the same line for the same reason:
   * this is §6's "on disk AND playable", judged over a whole meeting, and one
   * unreadable chunk that rejected the concatenation made the other fifty-nine
   * minutes unreachable while the recovery card went on advertising their bytes.
   * The dashboard's `readAudio` returns what it has plus `missing`; this is that
   * rule on this host (D1b).
   */
  async read(id: string): Promise<CapturedAudio> {
    const stored = await this.load(id);
    const parts: Buffer[] = [];
    const missing: number[] = [];
    const sequences = new Set(captureChunks(stored.session).map((chunk) => chunk.sequence));
    // Bytes land before their record update, and recovery deliberately preserves
    // later bytes across a sequence hole. The playback domain is therefore the
    // union of the ledger and every physical sequence, not only the contiguous
    // tail either one can currently claim.
    const physical = await this.physicalChunkSizes(id);
    for (const sequence of physical.keys()) sequences.add(sequence);
    let maximum = -1;
    for (const sequence of sequences) maximum = Math.max(maximum, sequence);
    if (maximum >= MAX_PLAYBACK_CHUNK_COUNT) {
      throw new Error('This recording has a saved-audio chunk sequence that is too large to play safely.');
    }
    // Walk the bounded 0..max domain so holes are explicit. Iterating only the
    // union would play sequences 0 and 2 back-to-back while claiming nothing
    // was missing; the bytes survive, and the missing sequence survives as fact.
    for (let sequence = 0; sequence <= maximum; sequence += 1) {
      // Do not turn one corrupt sparse filename into hundreds of thousands of
      // filesystem probes. Only a ledger or physical reference can have a file;
      // every other sequence in the bounded domain is already known missing.
      if (!sequences.has(sequence)) { missing.push(sequence); continue; }
      const bytes = await this.readSegment(id, sequence);
      if (!bytes?.byteLength) { missing.push(sequence); continue; }
      parts.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    }
    // Handed back as a plain `Uint8Array` view over the concatenation rather
    // than a `Buffer`: that is what structured clone delivers to the renderer,
    // so the declared type should not promise a Node-only subclass.
    const merged = Buffer.concat(parts);
    return {
      bytes: new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength),
      contentType: stored.contentType,
      missing,
    };
  }

  /**
   * D6 — the user accepted the meeting, so the audio is released.
   *
   * Unconditional, and deliberately: finalizing marks every unfinished segment
   * as a gap and then deletes the audio, so "is anybody still recording this?"
   * has to be answered BEFORE it — by the supervisor, which is the only thing in
   * this process that knows (invariant 5). A second guard here could only
   * re-derive that answer from the record, which is the heuristic this round
   * removed.
   */
  async finalize(id: string): Promise<void> {
    await this.close(id, finalizeCapture);
  }

  /** D6 — an explicit discard, and a real deletion rather than a hidden one. Guarded by its caller, like `finalize`. */
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
   * nothing anyone will ever be offered. A directory with NO record is an orphan
   * and is reaped too (D6); one whose record exists but is unreadable is
   * quarantined, because parse failure is not authority to delete physical audio.
   *
   * D6 — and a capture somebody is recording into is NONE of those four. It is
   * skipped whole rather than at one of the three places it would otherwise be
   * damaged: the byte-less reap used to be the only guarded one, which left the
   * record rewrite and the chunk adoption to run over a live recording and take
   * the rest of the meeting with them. It is still listed as a session, or the
   * orphan sweep at the end would delete the directory it just spared.
   */
  async recoverInterrupted(options: MeetingCaptureRecoveryOptions = {}): Promise<MeetingCaptureRecoveryReport> {
    const isWriting = options.isWriting ?? (() => false);
    const ids = await this.storedIds();
    const sessions: MeetingCaptureSession[] = [];
    const recovered: string[] = [];
    const adopted: string[] = [];
    const reaped: string[] = [];
    const quarantined: string[] = [];
    for (const id of ids) {
      const recoveryRecord = await this.loadForRecovery(id);
      if (recoveryRecord.kind === 'missing') continue;
      if (recoveryRecord.kind === 'unreadable') {
        // No session is invented here: without a readable scope, offering these
        // bytes under the active tenant could cross an org boundary. Excluding
        // the directory from the orphan sweep keeps the audio intact while
        // keeping it out of every recovery offer, on this boot and later ones.
        quarantined.push(id);
        continue;
      }
      const { stored } = recoveryRecord;
      if (isWriting(id)) { sessions.push(stored.session); continue; }
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
      const claimed = await this.claimStoredChunks(id, stored.session);
      if (captureChunks(claimed).length > captureChunks(stored.session).length) adopted.push(id);
      const session = recoverCaptureSession(claimed);
      const physicalAudio = [...(await this.physicalChunkSizes(id)).values()].some((byteLength) => byteLength > 0);
      // D6/D2 — a Record the user cancelled, or that died before its first chunk
      // reached the disk, leaves a record with no audio under it. `resumable`
      // will never offer it (no bytes) and the orphan rule below will never
      // claim it (it HAS a record), so without this it is a directory that
      // outlives every pass forever. The `openedAt` guard is what keeps this
      // from reaping a capture the CURRENT launch has just created and not yet
      // written a chunk for — that session is seconds old and about to have one.
      //
      // A sequence hole is the exception: it may prevent the shared adoption
      // rule from claiming later files, but incomplete metadata is not authority
      // to delete bytes that physically remain. Keep that directory for a later
      // repair even when the safe replacement session is byte-empty.
      //
      // `openedAt` only knows about THIS process, and that is now enough: a
      // capture a live window in this process is recording never reaches here
      // (`isWriting` above), and a SECOND process over the same `userData`
      // directory is prevented rather than detected — main takes Electron's
      // single-instance lock, which is the only thing that can actually make one
      // process's answer about liveness complete.
      if (capturedByteLength(session) === 0 && !physicalAudio && session.startedAt < this.openedAt) {
        await fs.promises.rm(this.directory(id), { recursive: true, force: true });
        reaped.push(id);
        continue;
      }
      sessions.push(session);
      const changed = stored.repaired
        || session.status !== stored.session.status
        || session.segments.length !== stored.session.segments.length
        || session.segments.some((segment, index) => segment !== stored.session.segments[index])
        || session.chunks !== stored.session.chunks;
      if (!changed) continue;
      await this.write(session, stored.contentType);
      recovered.push(id);
    }
    // The ones already deleted above are excluded here rather than being deleted
    // and counted twice. Unreadable existing records are excluded for the
    // opposite reason: their physical audio is quarantined, not orphaned.
    const orphanCandidates = ids.filter((entry) => !reaped.includes(entry) && !quarantined.includes(entry));
    for (const id of orphanCaptureIds(orphanCandidates, sessions)) {
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

  private async load(id: string): Promise<LoadedCapture> {
    const stored = await this.loadQuietly(id);
    if (!stored) throw new Error('That meeting capture is no longer on this device.');
    return stored;
  }

  private async loadQuietly(id: string): Promise<LoadedCapture | null> {
    // The id is validated OUTSIDE the try: "this is not a capture id" is a
    // programming error worth surfacing, while "there is no such record" is the
    // ordinary answer this method exists to give.
    const file = path.join(this.directory(id), RECORD_FILE);
    let raw: string;
    try { raw = await fs.promises.readFile(file, 'utf8'); }
    catch { return null; }
    return parseStored(raw, id);
  }

  /**
   * Recovery must distinguish ABSENT from PRESENT BUT UNREADABLE.
   *
   * Ordinary callers only need `loadQuietly`'s nullable answer. Boot does not:
   * it feeds nulls to the orphan sweep, where null means the whole directory may
   * be deleted. `lstat` first makes that destructive distinction explicit.
   */
  private async loadForRecovery(id: string): Promise<RecoveryCaptureRecord> {
    const file = path.join(this.directory(id), RECORD_FILE);
    try { await fs.promises.lstat(file); }
    catch (caught) { return isMissingPath(caught) ? { kind: 'missing' } : { kind: 'unreadable' }; }
    let raw: string;
    try { raw = await fs.promises.readFile(file, 'utf8'); }
    catch { return { kind: 'unreadable' }; }
    const stored = parseStored(raw, id);
    return stored ? { kind: 'loaded', stored } : { kind: 'unreadable' };
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
   * Believe the chunks — the FILES half of it, and only that half.
   *
   * D1 writes the bytes and THEN the record, so the last thing a kill can
   * interrupt is the record, leaving a chunk file the session does not
   * mention. Which of those files may be believed is `adoptCaptureChunks` in
   * `@kinqs/brainrouter-core/meetings`: contiguous from the end of the record,
   * non-empty, nothing for a terminal capture. That rule used to live here AND
   * in the dashboard, in two copies whose comments admitted nothing kept them
   * aligned — so it moved to core, where a durability-chunk sequence means the
   * same thing on both hosts (D1b).
   *
   * What is left here is the part that genuinely needs a filesystem: measuring
   * what each stored chunk actually holds. A chunk the shared rule rejects is
   * preserved, because a sequence hole is a statement about what can be claimed
   * now, not proof that later physical audio is disposable. This is deliberately
   * reversible across every later boot.
   *
   * Only the HIGHEST-indexed file can be a genuinely torn write, because
   * `writeSegment` serializes per session and only resolves after `close`. The
   * shared rule adopts it regardless, and that is the answer this host wants: a
   * truncated tail is at worst one chunk in a unit the endpoint cannot decode, which D5
   * turns into a stated gap with a retry — while deleting it is silent loss,
   * which is the failure this ADR exists to end.
   */
  private async claimStoredChunks(
    id: string,
    session: MeetingCaptureSession,
  ): Promise<MeetingCaptureSession> {
    const directory = this.directory(id);
    const physical = await this.physicalChunkSizes(id);
    const unclaimed = new Map<number, string>();
    for (const sequence of physical.keys()) {
      if (sequence < nextChunkSequence(session)) continue;
      unclaimed.set(sequence, segmentName(sequence));
    }
    if (!unclaimed.size) return session;

    const chunks: MeetingStoredChunk[] = [];
    for (const [sequence, entry] of unclaimed) {
      chunks.push({ sequence, byteLength: physical.get(sequence) ?? await fileSize(path.join(directory, entry)) });
    }
    // The nominal chunk length is the shared rule's own default and is left to
    // it: the measured elapsed time died with the process that measured it, and
    // a gap marker (D5) needs a range that is monotonic and about right.
    const adoption = adoptCaptureChunks(session, chunks);
    // Rejected does not mean disposable. A missing earlier sequence makes a
    // later chunk impossible to claim *today*, but another recovery or repair
    // may restore the hole. Keeping the physical file is the only reversible
    // answer, and applying it on every boot prevents a repaired manifest from
    // silently deleting the same tail one launch later.
    return adoption.session;
  }

  /** Physical chunk files and their measured sizes, keyed by durability sequence. */
  private async physicalChunkSizes(id: string): Promise<Map<number, number>> {
    const directory = this.directory(id);
    let entries: string[];
    try { entries = await fs.promises.readdir(directory); } catch { return new Map(); }
    const chunks = new Map<number, number>();
    for (const entry of entries) {
      const sequence = segmentIndex(entry);
      if (sequence === null) continue;
      chunks.set(sequence, await fileSize(path.join(directory, entry)));
    }
    return chunks;
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

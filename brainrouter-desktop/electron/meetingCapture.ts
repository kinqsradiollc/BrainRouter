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
 * 1. **Bytes first, record second.** `append` writes the segment file and only
 *    then rewrites `session.json`. A crash between the two leaves a segment file
 *    the record does not mention, which the next boot deletes; the reverse order
 *    would leave a record pointing at audio that does not exist, and recovery
 *    believes the record (`MeetingSegment.byteLength` is "what the host actually
 *    wrote").
 * 2. **The record lives inside the directory it describes.** So a terminal
 *    meeting is a `rm -rf`, not a tombstone that accumulates — D6 asks for a
 *    real deletion, and a store that keeps metadata about deleted audio forever
 *    is the kind of thing that turns into a retention incident.
 * 3. **Writes for one session are serialized.** Two overlapping `append` calls
 *    would both read the same session, and one would silently lose its segment.
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
  createCaptureSession,
  discardCapture,
  finalizeCapture,
  isMeetingSessionId,
  isTerminalCaptureStatus,
  orphanCaptureIds,
  recoverCaptureSession,
  resumableSessions,
  stopCapture,
  summarizeRecovery,
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
  readonly recovered: readonly string[];
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
 */
async function writeSegmentFile(file: string, bytes: Uint8Array): Promise<void> {
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fs.promises.open(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
    FILE_MODE,
  );
  try {
    await handle.chmod(FILE_MODE).catch(() => undefined);
    await handle.write(bytes);
  } finally {
    await handle.close();
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

  /** D1 — a chunk of audio, durable before it is anything else. */
  async append(id: string, bytes: Uint8Array, durationMs: number): Promise<MeetingCaptureSession> {
    return this.serialize(id, async () => {
      const stored = await this.load(id);
      await writeSegmentFile(path.join(this.directory(id), segmentName(stored.session.segments.length)), bytes);
      const session = appendSegment(stored.session, { byteLength: bytes.byteLength, durationMs });
      await this.write(session, stored.contentType);
      return session;
    });
  }

  /** Capture ended cleanly. The audio stays; only the status changes (D7). */
  async stop(id: string): Promise<MeetingCaptureSession> {
    return this.serialize(id, async () => {
      const stored = await this.load(id);
      const session = stopCapture(stored.session);
      if (session !== stored.session) await this.write(session, stored.contentType);
      return session;
    });
  }

  async session(id: string): Promise<MeetingCaptureSession> {
    return (await this.load(id)).session;
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
   * Two truths a crash leaves behind and both are corrected rather than
   * displayed: a session still marked `recording` is not, and a segment file
   * past the end of the record was never accounted for and is a torn tail.
   * Directories with no readable record are orphans and are reaped (D6).
   */
  async recoverInterrupted(): Promise<MeetingCaptureRecoveryReport> {
    const ids = await this.storedIds();
    const sessions: MeetingCaptureSession[] = [];
    const recovered: string[] = [];
    for (const id of ids) {
      const stored = await this.loadQuietly(id);
      if (!stored) continue;
      sessions.push(stored.session);
      await this.trimTornTail(id, stored.session);
      if (isTerminalCaptureStatus(stored.session.status)) continue;
      const session = recoverCaptureSession(stored.session);
      const changed = session.status !== stored.session.status
        || session.segments.some((segment, index) => segment !== stored.session.segments[index]);
      if (!changed) continue;
      await this.write(session, stored.contentType);
      recovered.push(id);
    }
    const reaped = orphanCaptureIds(ids, sessions);
    for (const id of reaped) await fs.promises.rm(path.join(this.root, id), { recursive: true, force: true });
    return { recovered, reaped };
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

  private async trimTornTail(id: string, session: MeetingCaptureSession): Promise<void> {
    const directory = this.directory(id);
    let entries: string[];
    try { entries = await fs.promises.readdir(directory); } catch { return; }
    for (const entry of entries) {
      const index = segmentIndex(entry);
      if (index === null || index < session.segments.length) continue;
      await fs.promises.rm(path.join(directory, entry), { force: true });
    }
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

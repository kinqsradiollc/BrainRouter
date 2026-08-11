/**
 * ADR-035 D2/D3/D9 — what the dashboard keeps in the capture manifest, and how a
 * meeting is put back together from it after the tab is gone.
 *
 * `captureStore.ts` deliberately treats the manifest `payload` as opaque text:
 * the store owns bytes and ordering, not what a meeting IS. This module is the
 * other side of that seam — it owns the envelope, and it is the ONLY place that
 * turns stored bytes back into a `MeetingCaptureSession`.
 *
 * The session model itself is imported, not restated (D1b: "the session model,
 * the segment protocol, and the recovery flow are shared — only the write target
 * is host-specific"). Everything below is the host-specific half: JSON in a
 * browser store, and the reconciliation between what the store actually holds
 * and what the last successful write claimed.
 *
 * That reconciliation is the point of the module, and it is not bookkeeping.
 * `captureStore.ts` states the invariant it lives by — "the bytes are the truth;
 * the manifest is a convenience" — because D1b says a closing tab gets very
 * little time. So a chunk can land and the session write that was supposed to
 * mention it can not. Read the manifest alone and that audio is invisible
 * forever: on disk, holding quota, in no transcript, offered back by nothing.
 * `restoreCaptureSession` closes that gap by believing the chunks.
 *
 * The other invariant here, which the transcription queue depends on absolutely:
 * **a unit names every durability chunk it spans.** Before D9 one segment was
 * one chunk and `index === sequence`; current records carry `session.chunks`
 * plus `segment.chunks`. Recovery validates both rather than guessing, because
 * reading only the first referenced chunk would produce plausible but incomplete
 * text with no visible gap.
 *
 * **Liveness is deliberately NOT in this envelope.** It was: a lease with a
 * heartbeat stamp, mirrored beside the session so a damaged payload still named
 * its writer. On this host that answer is `captureLock.ts` — a Web Lock, held for
 * the life of the recording and released by the BROWSER when the tab dies — so a
 * stamp here could only ever be a second, slower opinion about the same fact.
 * Worse, a stale one: after a kill the stamp stays fresh for the length of the
 * old threshold, and a session restored with it would be withheld from the
 * recovery offer for exactly as long as §6 says it must not be. So a lease found
 * in a record written by an older build is READ AND DROPPED, not honoured.
 */
import {
  adoptCaptureChunks,
  captureChunks,
  createCaptureSession,
  isMeetingCaptureSession,
  isMeetingSessionId,
  isTerminalCaptureStatus,
  recoverCaptureSession,
  resumableSessions,
  type MeetingCaptureScope,
  type MeetingCaptureSession,
  type MeetingCaptureTemplate,
} from "@kinqs/brainrouter-core/meetings";

import { captureManifestChunkMs } from "./captureStorage";
import type { CaptureSessionRecord } from "./captureStore";

/**
 * The envelope written to the manifest.
 *
 * `mimeType` is beside the session rather than in it because it is a property of
 * THIS host's `MediaRecorder`, not of what a meeting is — the desktop answers
 * the same question with its own `contentType` field. `title` is kept
 * separately too, so a capture recorded before the session model existed still
 * comes back with its name.
 *
 * There is no `writer` field. The envelope describes what the meeting IS; who is
 * writing to it at this instant is a question about live tabs, and it is asked
 * of the browser (`captureLock.ts`) rather than of bytes that were written down
 * some unknown time ago.
 */
export interface CapturePayload {
  readonly title?: string;
  readonly mimeType?: string;
  readonly session?: MeetingCaptureSession;
}

interface DecodedCapturePayload {
  readonly payload: CapturePayload;
  readonly rawSession?: unknown;
}

interface RecoverableSessionMetadata {
  readonly startedAt?: string;
  readonly scope?: MeetingCaptureScope;
  readonly title?: string;
  readonly template?: MeetingCaptureTemplate;
  readonly language?: string;
}

const MAX_CAPTURE_TITLE_LENGTH = 500;
const MAX_CAPTURE_MIME_TYPE_LENGTH = 255;
const MAX_CAPTURE_SCOPE_ID_LENGTH = 256;
const MAX_CAPTURE_LANGUAGE_LENGTH = 64;
const MAX_CAPTURE_INSTANT_LENGTH = 64;
const CAPTURE_TEMPLATES = new Set<MeetingCaptureTemplate>(["general", "standup", "one-on-one", "retrospective"]);
const LANGUAGE_TAG = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export function serializeCapturePayload(payload: CapturePayload): string {
  return JSON.stringify(payload);
}

/**
 * Read the envelope, tolerating anything.
 *
 * Never throws. A payload we cannot read must not make the audio beside it
 * unreachable — that would turn a one-byte JSON problem into a lost meeting,
 * which is the trade this ADR exists to refuse.
 */
export function parseCapturePayload(text: string): CapturePayload {
  return decodeCapturePayload(text).payload;
}

/**
 * The exact physical sequences a valid matching session claims were written.
 *
 * Playback uses this only to name a claimed trailing chunk whose file has gone
 * missing. It never restores a session or supplies a scope: damaged JSON and a
 * valid session copied from another record both return `undefined`, so audio
 * integrity cannot turn into tenant inference.
 */
export function capturePayloadChunkSequences(text: string, sessionId: string): readonly number[] | undefined {
  const session = parseCapturePayload(text).session;
  if (!session || session.id !== sessionId) return undefined;
  return captureChunks(session).map((chunk) => chunk.sequence);
}

/**
 * Whether a manifest's opaque payload independently authorizes audio deletion.
 *
 * The top-level `closed` bit is an index hint, not deletion authority: a torn
 * write can flip it without successfully persisting the terminal session. The
 * shared validator supplies the required lifecycle timestamps, the id match
 * binds that verdict to these physical bytes, and no scope is ever invented.
 */
export function capturePayloadAuthorizesDeletion(text: string, sessionId: string): boolean {
  const session = parseCapturePayload(text).session;
  return session?.id === sessionId && isTerminalCaptureStatus(session.status);
}

function decodeCapturePayload(text: string): DecodedCapturePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    return { payload: {} };
  }
  if (!isRecord(parsed)) return { payload: {} };
  const candidate = parsed as { title?: unknown; mimeType?: unknown; session?: unknown };
  const title = boundedText(candidate.title, MAX_CAPTURE_TITLE_LENGTH);
  const mimeType = boundedText(candidate.mimeType, MAX_CAPTURE_MIME_TYPE_LENGTH);
  return {
    payload: {
      ...(title === undefined ? {} : { title }),
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(isMeetingCaptureSession(candidate.session) ? { session: candidate.session } : {}),
    },
    ...(candidate.session === undefined ? {} : { rawSession: candidate.session }),
  };
}

export interface RestoreCaptureInput {
  readonly record: CaptureSessionRecord;
  /**
   * The scope to mint a session under when the manifest has none. It is NOT
   * applied to a session that already has one: open question 5 — a recording
   * started under one org must not silently land in another, and the moment it
   * is offered back is exactly where that would happen.
   */
  readonly scope: MeetingCaptureScope;
  readonly template?: MeetingCaptureTemplate;
  readonly language?: string;
  /** Duration credited to a durability chunk the manifest never described. */
  readonly chunkMs?: number;
  /** @deprecated Use `chunkMs`; retained for callers restoring a pre-D9 fixture. */
  readonly segmentMs?: number;
  /** ISO instant used for the recovery stamp; injected by tests. */
  readonly at?: string;
}

/**
 * D2's recovery half — the session a stored capture actually represents.
 *
 * Three things happen, in this order, and the order matters:
 *
 * 1. **Adopt or mint.** A manifest written by this build carries the session. A
 *    capture recorded before it did (or one whose payload is unreadable) gets a
 *    fresh session minted over the same id, so old recordings keep working
 *    rather than becoming unreachable audio.
 * 2. **Believe the chunks.** Any chunk the ledger does not describe is adopted
 *    into it, then the shared unit policy groups the recovered tail. That rule
 *    is `adoptCaptureChunks` — both hosts used to write it out for themselves,
 *    and a pure rule kept aligned by attention is one edit away from diverging.
 *    What is left here is host policy: this store leaves chunks past a hole
 *    where they are (`rejected`) for its own reap to claim.
 * 3. **Recover.** `recoverCaptureSession` is the shared rule: nothing is
 *    recording any more, an open tail is sealed, and a unit left mid-attempt did
 *    not succeed. It runs LAST because step 2 needs a session that still accepts
 *    appends.
 */
export function restoreCaptureSession(input: RestoreCaptureInput): MeetingCaptureSession {
  const decoded = decodeCapturePayload(input.record.payload);
  const payload = decoded.payload;
  const storedPayloadSession = payload.session && payload.session.id === input.record.sessionId
    ? payload.session
    : undefined;
  const metadata = recoverableSessionMetadata(decoded.rawSession, input.record.sessionId);
  const startedAt = metadata.startedAt ?? boundedInstant(input.record.startedAt);
  const stored = storedPayloadSession
    ? storedPayloadSession
    : createCaptureSession({
      id: isMeetingSessionId(input.record.sessionId) ? input.record.sessionId : undefined,
      ...(startedAt ? { startedAt } : {}),
      scope: metadata.scope ?? input.scope,
      ...((metadata.title ?? payload.title) ? { title: metadata.title ?? payload.title } : {}),
      ...((metadata.template ?? input.template) ? { template: metadata.template ?? input.template } : {}),
      ...((metadata.language ?? input.language) ? { language: metadata.language ?? input.language } : {}),
    });
  // A lease written by an older build is dropped here. `isResumableSession` no
  // longer reads it — the field is gone from the shared model and
  // `recoverCaptureSession` drops it too — so this is belt to that braces, and
  // it stays because it is the earlier of the two: a stamp reaches adoption
  // before it reaches recovery, and a terminal session skips recovery
  // altogether. Cast because the shape is no longer part of a session; what is
  // read here is what an older build left on the device. Liveness on this host
  // is the Web Lock, and only the Web Lock.
  const { writer: _legacy, ...withoutWriter } = stored as MeetingCaptureSession & { writer?: unknown };
  // A marker-less record with no usable session payload predates the ledger.
  // The current constructor includes `chunks: []`, so drop that freshly-minted
  // field only for that genuinely legacy shape. A D9 marker lives outside the
  // payload precisely so damaged current JSON still adopts every physical chunk
  // at its short cadence instead of stretching it to old 20-second blobs.
  let adopted: MeetingCaptureSession = withoutWriter;
  const storedChunkMs = captureManifestChunkMs(input.record.chunkMs);
  const requestedChunkMs = captureManifestChunkMs(input.chunkMs);
  if (!storedPayloadSession && storedChunkMs === undefined && requestedChunkMs === undefined) {
    const { chunks: _newLedger, ...legacy } = withoutWriter;
    adopted = legacy;
  }
  const adoptionChunkMs = requestedChunkMs ?? storedChunkMs;
  const adoptionDuration = adoptionChunkMs !== undefined
    ? { chunkMs: adoptionChunkMs }
    : input.segmentMs !== undefined
      ? { segmentMs: input.segmentMs }
      : {};
  const reconciled = adoptCaptureChunks(adopted, input.record.chunks, adoptionDuration);
  return recoverCaptureSession(reconciled.session, input.at);
}

/**
 * Recover only identity metadata from a damaged current session.
 *
 * The id match is the authority boundary: without it, JSON copied from another
 * record could move that recording's tenant/title onto these physical bytes.
 * Lifecycle and audio fields are intentionally absent from the return type — a
 * corrupt `status`, ledger, unit list or terminal timestamp is never carried
 * into the freshly minted recording session that adopts the store's bytes.
 */
function recoverableSessionMetadata(value: unknown, sessionId: string): RecoverableSessionMetadata {
  if (!isRecord(value) || value.id !== sessionId || !isMeetingSessionId(value.id)) return {};
  const startedAt = boundedInstant(value.startedAt);
  const scope = boundedCaptureScope(value.scope);
  const title = boundedText(value.title, MAX_CAPTURE_TITLE_LENGTH);
  const template = typeof value.template === "string" && CAPTURE_TEMPLATES.has(value.template as MeetingCaptureTemplate)
    ? value.template as MeetingCaptureTemplate
    : undefined;
  const language = boundedLanguage(value.language);
  return {
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(scope === undefined ? {} : { scope }),
    ...(title === undefined ? {} : { title }),
    ...(template === undefined ? {} : { template }),
    ...(language === undefined ? {} : { language }),
  };
}

function boundedCaptureScope(value: unknown): MeetingCaptureScope | undefined {
  if (!isRecord(value)) return undefined;
  const orgId = value.orgId === null ? null : boundedText(value.orgId, MAX_CAPTURE_SCOPE_ID_LENGTH);
  if (orgId === undefined) return undefined;
  const workspaceId = value.workspaceId === undefined || value.workspaceId === null
    ? null
    : boundedText(value.workspaceId, MAX_CAPTURE_SCOPE_ID_LENGTH);
  if (workspaceId === undefined) return undefined;
  return { orgId, workspaceId };
}

function boundedLanguage(value: unknown): string | undefined {
  const language = boundedText(value, MAX_CAPTURE_LANGUAGE_LENGTH);
  return language && LANGUAGE_TAG.test(language) ? language : undefined;
}

function boundedInstant(value: unknown): string | undefined {
  const instant = boundedText(value, MAX_CAPTURE_INSTANT_LENGTH);
  return instant && Number.isFinite(Date.parse(instant)) ? instant : undefined;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length <= maxLength ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Open question 5 — a stored capture, restored, alongside the record its audio
 * still lives in.
 *
 * Both halves are needed by the surface and neither is derivable from the other:
 * the session is what `summarizeRecovery` describes and what a pick-up resumes,
 * and the record is what Play reads and what Discard deletes.
 */
export interface ResumableCapture {
  readonly record: CaptureSessionRecord;
  readonly session: MeetingCaptureSession;
}

export interface ResumableCaptureOptions {
  /**
   * The workspace in context. A capture recorded under one organization is not
   * offered back under another — ADR-019's switcher can move while a meeting is
   * unfinished, and the offer is precisely where that recording would change
   * hands.
   */
  readonly scope: MeetingCaptureScope;
  /**
   * Ids to leave out whatever their record says.
   *
   * Two kinds, and the second is the whole of "a live recording is not offered
   * back": the capture in hand, which is unfinished by definition and would be
   * nonsense to offer while its microphone is still open, and every capture some
   * tab of this origin currently HOLDS THE LOCK for. The record cannot answer
   * that second one — nothing in it is about live tabs — so the caller asks
   * `captureLock.ts` and hands the answer in here.
   */
  readonly exclude?: readonly string[];
  /**
   * The instant the offer is judged at, threaded so the recovery stamp is a
   * reading a test can pin rather than whatever the wall clock said between two
   * statements.
   */
  readonly at?: string;
}

/**
 * D2's recovery offer for this host, decided by the SHARED predicate.
 *
 * The store cannot answer this: it treats `payload` as opaque text on purpose,
 * so it can see neither a session's scope nor its terminal state, and the
 * `!closed && byteLength > 0` it used to filter by was D2's rule written down a
 * second time — one that could not have a scope in it and drifted the moment
 * open question 5 was answered. This module owns the record → session mapping,
 * so it is where `resumableSessions` can be asked instead of imitated.
 */
export function resumableCaptures(
  records: readonly CaptureSessionRecord[],
  options: ResumableCaptureOptions,
): readonly ResumableCapture[] {
  const excluded = new Set(options.exclude ?? []);
  const at = options.at ?? new Date().toISOString();
  const candidates = records
    .filter((record) => !excluded.has(record.sessionId))
    // `closed` is the manifest's recovery-offer index. Honouring it first keeps
    // a damaged payload from being re-homed under a newly minted recording, but
    // it is not deletion authority: `reapOrphans` separately requires a valid,
    // matching terminal payload before recursively removing any audio.
    .filter((record) => !record.closed)
    .map((record) => ({ record, session: restoreCaptureSession({ record, scope: options.scope, at }) }));
  // No instant is threaded into the shared rule, because it no longer has one to
  // take: "audio present, no terminal state" is a question about a record, and
  // every answer it used to give a clock was an answer about a writer that had
  // already been killed. `at` above still stamps the RECOVERY, which is a fact
  // about when this launch found the meeting.
  const offered = new Set(
    resumableSessions(candidates.map((candidate) => candidate.session), { scope: options.scope })
      .map((session) => session.id),
  );
  // Ordered by the shared rule's own answer (newest first), not by the store's
  // listing: two surfaces that sort a recovery offer differently are two
  // surfaces a user has to learn twice.
  return candidates
    .filter((candidate) => offered.has(candidate.session.id))
    .sort((left, right) => right.session.startedAt.localeCompare(left.session.startedAt));
}

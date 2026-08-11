/**
 * ADR-035 D1b — the contract a durable browser capture store must satisfy, plus
 * the two pure rules that make one safe to build on.
 *
 * What this module owns: the backend seam (`CaptureStorageBackend`), the shape
 * of what gets stored beside the audio, the session-id and chunk-key alphabets,
 * and which backend a given browser should get. What it deliberately does NOT
 * own: any browser API. OPFS and IndexedDB sit behind this interface
 * (`opfsCaptureBackend.ts`, `indexedDbCaptureBackend.ts`) and everything with a
 * decision in it sits above it (`captureStore.ts`), because neither OPFS nor
 * IndexedDB exists in the test runner — logic that no test can execute is logic
 * nobody has checked, and this is the module whose whole job is not losing a
 * recording.
 *
 * Invariants:
 *
 * 1. **A session id becomes a directory name**, so it is validated here at the
 *    boundary before it can become a path. A traversal bug in a store that holds
 *    microphone audio is not a bug anyone gets to find in production.
 * 2. **Chunk keys sort lexically in sequence order.** OPFS returns directory
 *    entries in an unspecified order, so zero-padding is what keeps an hour of
 *    audio reassembling in the order it was spoken rather than in the order the
 *    filesystem felt like listing.
 * 3. **The bytes are the truth; the manifest is a convenience.** `listChunks`
 *    reports what a backend actually holds, never what a record claims to hold.
 *    D1b is explicit that a closing tab gets very little time, so nothing may
 *    depend on a bookkeeping write that the tab never got to make.
 *
 * The manifest `payload` is opaque text on purpose. The meeting session model
 * (status, segments, transcript) is shared and lives in
 * `@kinqs/brainrouter-core/meetings`; this file is storage, and storage that
 * knew the shape of a meeting would be the beginning of a second, quietly
 * divergent model — the ADR-029 failure D1b names by name. `capturePayload.ts`
 * owns the envelope; this file moves the bytes it is given.
 */
import {
  DEFAULT_MEETING_CHUNK_MS,
  isMeetingSessionId,
  newMeetingSessionId,
} from "@kinqs/brainrouter-core/meetings";

/**
 * Which durable store is actually in use.
 *
 * Reported rather than inferred: golden rule 23 — a fallback nobody can see is
 * an outage nobody can explain, and "OPFS quietly wasn't available" is exactly
 * the sentence a lost meeting would otherwise be explained by.
 */
export type CaptureStorageKind = "opfs" | "indexeddb";

/** One chunk of audio as the store FOUND it — the size is measured, not claimed. */
export interface CaptureChunkRef {
  readonly sequence: number;
  readonly byteLength: number;
}

/**
 * The small record written beside a session's audio.
 *
 * `closed` is a boolean rather than the session model's status union because the
 * store must be able to answer "offer this one back?" without parsing `payload`.
 * The caller sets it from its own terminal-state check, so there is one
 * definition of terminal and it is not this file's.
 */
export interface CaptureManifest {
  readonly startedAt: string;
  readonly closed: boolean;
  readonly payload: string;
  /**
   * Durability cadence of the physical chunks beside this manifest.
   *
   * Kept outside the opaque payload so recovery still knows how to place audio
   * on the timeline when that payload is torn or from an incompatible build.
   * Absence is the backward-compatible signal for pre-D9 20-second blobs.
   */
  readonly chunkMs?: number;
}

/**
 * The result of reading the top-level record beside a capture.
 *
 * `absent` and `corrupt` are deliberately different. Audio with no manifest is
 * an unreachable orphan the reap may reclaim; audio beside a manifest whose
 * bytes exist but cannot be understood may still be the only copy of a meeting
 * and must be quarantined in place rather than deleted or offered to a tenant.
 */
export type CaptureManifestRead =
  | { readonly state: "absent" }
  | { readonly state: "corrupt" }
  | { readonly state: "present"; readonly manifest: CaptureManifest };

export const MIN_CAPTURE_MANIFEST_CHUNK_MS = 2_000;
export const MAX_CAPTURE_MANIFEST_CHUNK_MS = 5_000;

/** The manifest can only claim the D9 durability range, in whole milliseconds. */
export function isCaptureManifestChunkMs(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_CAPTURE_MANIFEST_CHUNK_MS
    && value <= MAX_CAPTURE_MANIFEST_CHUNK_MS;
}

/**
 * Read a marker without turning a damaged current record into a legacy one.
 *
 * Absence means pre-D9. Presence with an invalid value is still evidence that
 * the writer used split durability chunks, so it falls back to the shared D9
 * cadence instead of stretching each physical blob to twenty seconds.
 */
export function captureManifestChunkMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return isCaptureManifestChunkMs(value) ? value : DEFAULT_MEETING_CHUNK_MS;
}

/**
 * The seam. Everything here is byte movement with no policy in it, so that the
 * two implementations that cannot be run by a test stay small enough to read.
 */
export interface CaptureStorageBackend {
  readonly kind: CaptureStorageKind;
  writeChunk(sessionId: string, sequence: number, bytes: Blob): Promise<void>;
  readChunk(sessionId: string, sequence: number): Promise<Blob | undefined>;
  /** What is actually stored, in whatever order the store hands it over. */
  listChunks(sessionId: string): Promise<readonly CaptureChunkRef[]>;
  writeManifest(sessionId: string, manifest: CaptureManifest): Promise<void>;
  readManifest(sessionId: string): Promise<CaptureManifestRead>;
  /** Every session id with anything stored — including audio whose manifest is missing. */
  listSessionIds(): Promise<readonly string[]>;
  deleteSession(sessionId: string): Promise<void>;
}

/**
 * Zero-padding width for a chunk key. Six digits is 999,999 chunks — even at
 * D9's shortest two-second durability cadence that is over 23 days of
 * continuous recording, so the ceiling is theatre; what matters is that every
 * key is the same width and therefore sorts as a string exactly as it sorts as
 * a number.
 */
export const CAPTURE_CHUNK_KEY_DIGITS = 6;

export const MAX_CAPTURE_CHUNK_SEQUENCE = 10 ** CAPTURE_CHUNK_KEY_DIGITS - 1;

/** Chunk files are raw recorder output, not a playable container on their own. */
export const CAPTURE_CHUNK_SUFFIX = ".part";

/** The manifest's file name inside an OPFS session directory. */
export const CAPTURE_MANIFEST_NAME = "manifest.json";

/**
 * The id alphabet is the SHARED one (`isMeetingSessionId`), not a second copy of
 * it.
 *
 * A session id names a directory on both hosts, and the shared model already
 * refuses to mint one containing a path separator for exactly that reason. Two
 * regexes for one rule is how a traversal guard ends up enforced in one host and
 * not the other; this is the store's boundary check, delegating to the rule.
 */
export function isCaptureSessionId(value: unknown): value is string {
  return isMeetingSessionId(value);
}

/** Every entry point that can turn a caller's string into a path goes through here. */
export function assertCaptureSessionId(value: string): string {
  if (!isCaptureSessionId(value)) {
    throw new Error("A meeting capture id must be 1–128 characters of letters, digits, dash or underscore.");
  }
  return value;
}

/** A path-safe random id, minted by the shared model so both hosts name captures alike. */
export const newCaptureSessionId = newMeetingSessionId;

export function captureChunkKey(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > MAX_CAPTURE_CHUNK_SEQUENCE) {
    throw new Error(`A capture chunk sequence must be an integer between 0 and ${MAX_CAPTURE_CHUNK_SEQUENCE}.`);
  }
  return `${String(sequence).padStart(CAPTURE_CHUNK_KEY_DIGITS, "0")}${CAPTURE_CHUNK_SUFFIX}`;
}

/** The inverse, tolerant of anything else a directory happens to contain. */
export function captureChunkSequence(key: string): number | undefined {
  if (!key.endsWith(CAPTURE_CHUNK_SUFFIX)) return undefined;
  const digits = key.slice(0, -CAPTURE_CHUNK_SUFFIX.length);
  if (digits.length !== CAPTURE_CHUNK_KEY_DIGITS || !/^\d+$/.test(digits)) return undefined;
  return Number(digits);
}

export interface CaptureStorageCapabilities {
  readonly opfs: boolean;
  readonly indexedDb: boolean;
}

/**
 * D1b names the order: OPFS first because it is the closest analogue to the
 * desktop's disk append, IndexedDB where OPFS is unavailable. `undefined` means
 * this browser can offer neither, which the caller must surface — recording into
 * a store that does not exist is the silent loss the ADR exists to end.
 */
export function selectCaptureBackendKind(capabilities: CaptureStorageCapabilities): CaptureStorageKind | undefined {
  if (capabilities.opfs) return "opfs";
  if (capabilities.indexedDb) return "indexeddb";
  return undefined;
}

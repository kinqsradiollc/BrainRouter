/**
 * ADR-035 D6 — the compose draft, in the protected store rather than in
 * `localStorage`.
 *
 * D6 says it in one line: "**Audio is never written to `localStorage` or any
 * renderer-accessible store.** The existing text draft should move to the same
 * protected location for the same reason — meeting content is not credential
 * material, but it is not something to leave in a store any page script can
 * read." The draft was left behind when the audio moved, and D4 then made it
 * worse: the live transcript was mirrored into it, so two minutes of a meeting's
 * actual words accumulated in a synchronous, enumerable, origin-wide key/value
 * store.
 *
 * **The same protected location, literally.** The draft is a manifest payload in
 * the capture store — the module that already owns quota, serialization and
 * deletion for this origin's meeting data. A separate OPFS/IndexedDB ladder
 * beside it would be a second store to open, a second fallback to explain and
 * (per `captureStorage.ts`'s own argument) a second pile of browser calls no
 * test can execute. The store treats `payload` as opaque text on purpose, so a
 * draft is a payload it is already able to hold.
 *
 * One invariant makes the reserved id safe to keep in that listing, and one
 * caller-side guard is what keeps it there — the difference matters, because
 * only the first is structural:
 *
 * 1. **It can never be offered back as a meeting.** It holds no chunks, and
 *    `isResumableSession` requires audio, so `resumableCaptures` cannot surface
 *    it however the payload is shaped. Nothing has to remember this.
 * 2. **The reap CAN take it, and one `if` is what stops it.** This used to say
 *    the store left the draft alone "exactly like a recording in progress",
 *    which stopped being true when `reapOrphans` gained its third category: a
 *    manifest that is not closed, holds no audio and that nobody is writing to
 *    is reclaimed, and that is precisely the draft's shape. Verified against a
 *    real store — `reapOrphans({ abandoned: async () => true })` deletes a
 *    written draft and `readMeetingDraft` comes back empty. What actually
 *    protects it is the surface's `abandoned` predicate, whose first line is
 *    `if (record.sessionId === MEETING_DRAFT_CAPTURE_ID) return false;`, because
 *    the store treats the payload as opaque and cannot tell that one id in its
 *    listing is not a meeting. Any other caller of `reapOrphans` has to say the
 *    same thing.
 *
 * `takeLegacyMeetingDraft` is the other half of "move": a draft already sitting
 * in `localStorage` is read once and REMOVED. Leaving it would mean the words
 * this decision is about stayed exactly where D6 says they must not be, with a
 * copy elsewhere.
 *
 * Everything with a decision in it here is pure and takes its store as an
 * argument, so the whole path is exercised by the same fixture the capture store
 * is tested with.
 */
import type { MeetingCaptureStore } from "./captureStore";

/**
 * The reserved capture id the draft lives under.
 *
 * Named, not derived, and deliberately not `mtg-`-shaped: it must be
 * recognisable in a store listing as the one entry that is not a meeting.
 */
export const MEETING_DRAFT_CAPTURE_ID = "brainrouter-meeting-draft";

/** Where the draft used to live, and the only reason this constant still exists. */
export const LEGACY_MEETING_DRAFT_KEY = "brainrouter:meeting-draft";

/**
 * What a compose form is worth restoring.
 *
 * `transcript` is the compose box WHOLE, exactly as the person left it — never a
 * subset of it, and specifically never `MeetingDraftReconciliation.retained`.
 * Storing the retained complement is the obvious way to keep the draft and the
 * session from both claiming the same sentence, and it corrupts the draft:
 * `retained` is what is left after the segments are stripped out, so reopening
 * reconciles a stripped box against the same session a second time and the
 * result is not the box. A retained line that matches a segment pins the
 * frontier and silently loses everything after it; a hand-corrected sentence
 * comes back doubled; a deleted line returns; a typed note is relocated.
 *
 * Nothing downstream can detect that either — a stripped box and a legitimately
 * empty one are the same string in the same relation to the same session, since
 * the fact that separates them is precisely what the stripping removed. So the
 * invariant lives here, in the type's own contract: what goes in is the box.
 * Reconciling against a session is a READ-side operation, done once when a
 * restored draft meets a recovered capture, and its result is never written
 * back.
 */
export interface MeetingDraft {
  readonly title: string;
  readonly transcript: string;
  readonly language: string;
  readonly template: string;
}

export const EMPTY_MEETING_DRAFT: MeetingDraft = { title: "", transcript: "", language: "", template: "" };

/** Nothing worth keeping — the two fields a person can see themselves having typed. */
export function isEmptyMeetingDraft(draft: MeetingDraft): boolean {
  return !draft.title && !draft.transcript;
}

export function serializeMeetingDraft(draft: MeetingDraft): string {
  return JSON.stringify(draft);
}

/**
 * Read a stored draft, tolerating anything.
 *
 * Never throws and never returns a partial shape: a draft we cannot read must
 * not be able to stop the Meetings page rendering, which is the whole library
 * and not just this form.
 */
export function parseMeetingDraft(text: string): MeetingDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    return EMPTY_MEETING_DRAFT;
  }
  if (!parsed || typeof parsed !== "object") return EMPTY_MEETING_DRAFT;
  const candidate = parsed as Record<string, unknown>;
  return {
    title: typeof candidate.title === "string" ? candidate.title : "",
    transcript: typeof candidate.transcript === "string" ? candidate.transcript : "",
    language: typeof candidate.language === "string" ? candidate.language : "",
    template: typeof candidate.template === "string" ? candidate.template : "",
  };
}

export async function readMeetingDraft(store: MeetingCaptureStore): Promise<MeetingDraft> {
  const record = await store.read(MEETING_DRAFT_CAPTURE_ID);
  return record ? parseMeetingDraft(record.payload) : EMPTY_MEETING_DRAFT;
}

/**
 * Write the draft, creating its record the first time.
 *
 * `setPayload` refuses a session that does not exist and `begin` refuses one
 * that does, so the pair is tried in that order — and once more in reverse,
 * because two debounced saves can reach `begin` together and only one of them
 * can win. The loser is not an error: the record it wanted now exists.
 */
export async function writeMeetingDraft(store: MeetingCaptureStore, draft: MeetingDraft): Promise<void> {
  if (isEmptyMeetingDraft(draft)) {
    await clearMeetingDraft(store);
    return;
  }
  const payload = serializeMeetingDraft(draft);
  try {
    await store.setPayload(MEETING_DRAFT_CAPTURE_ID, payload);
    return;
  } catch {
    // No record yet — the ordinary first save.
  }
  try {
    await store.begin({ sessionId: MEETING_DRAFT_CAPTURE_ID, payload });
  } catch {
    await store.setPayload(MEETING_DRAFT_CAPTURE_ID, payload);
  }
}

/** D6 — a deletion, not a blanking: an empty draft leaves nothing behind to read. */
export async function clearMeetingDraft(store: MeetingCaptureStore): Promise<void> {
  await store.delete(MEETING_DRAFT_CAPTURE_ID);
}

/** The subset of `Storage` this needs, so a test does not have to be a browser. */
export interface LegacyDraftStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/**
 * Take the draft out of `localStorage` — read it and remove it, in that order.
 *
 * Returns `null` when there was nothing there, so a caller can tell "migrated a
 * draft" from "there was none" without inspecting the fields. Removal happens
 * even for an unreadable value: D6's objection is to the words being there at
 * all, and a payload we cannot parse is still the meeting content.
 */
export function takeLegacyMeetingDraft(storage: LegacyDraftStorage): MeetingDraft | null {
  let raw: string | null;
  try {
    raw = storage.getItem(LEGACY_MEETING_DRAFT_KEY);
  } catch {
    return null;
  }
  try {
    storage.removeItem(LEGACY_MEETING_DRAFT_KEY);
  } catch {
    // A storage that will not delete is one we cannot fix from here; the draft
    // is still migrated so at least the protected copy becomes the live one.
  }
  if (raw === null) return null;
  const draft = parseMeetingDraft(raw);
  return isEmptyMeetingDraft(draft) ? null : draft;
}

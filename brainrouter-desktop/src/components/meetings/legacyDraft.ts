/**
 * ADR-035 D6 — emptying the store the compose draft used to live in.
 *
 * This module owns one thing: taking `brainrouter:desktop-meeting-draft` out of
 * `localStorage` and handing whatever was in it to the host's protected draft
 * file. It exists as a module rather than as a few lines inside the compose form
 * because of WHERE it has to run and WHEN, and both were wrong while it lived
 * there:
 *
 * - **It ran only when the composer opened.** A user who upgrades and then only
 *   reads old summaries kept the previous build's draft indefinitely. That is
 *   not hypothetical: once D4 began folding live transcript into the compose
 *   box, this key was rewritten every 250 ms with the recorded meeting's own
 *   words. So the migration belongs to the meetings VIEW, which mounts whenever
 *   a user looks at meetings at all.
 * - **Removal was gated on the value parsing into today's shape.** A record
 *   written by an older build, or a half-written one, kept its words forever.
 *   D6's objection is to the words being in that store at all, not to their
 *   shape, so the key is removed whatever it holds.
 * - **The hand-over was deferred to the autosave's 250 ms debounce, whose
 *   cleanup cancelled it.** Closing the composer inside that window left the
 *   draft nowhere at all. The write here is immediate and awaited.
 *
 * Invariants:
 *
 * 1. **The key is removed exactly once, unconditionally, before anything else
 *    can fail.** Read-and-remove is one step; nothing later in this file can
 *    leave the words behind.
 * 2. **Words are never destroyed silently.** If the protected store cannot take
 *    them — an older preload with no draft channel, or a write that threw — the
 *    parsed draft is RETURNED so the compose form can still restore it in this
 *    session. Deleting is what D6 asks for; deleting and forgetting is not.
 * 3. **It never rejects.** The caller holds this promise for the lifetime of the
 *    view and a rejection nobody awaited is an unhandled rejection in the
 *    renderer, on a path whose entire purpose is tidying up.
 */
import type { MeetingCaptureTemplate } from "@kinqs/brainrouter-core/meetings";
import type { MeetingCaptureOps, MeetingComposeDraft } from "./captureOps.js";

/**
 * Where the compose draft used to live. Nothing writes it any more — this module
 * is the only reference left, and it exists to empty it.
 */
export const LEGACY_DRAFT_KEY = "brainrouter:desktop-meeting-draft";

const TEMPLATES: readonly MeetingCaptureTemplate[] = ["general", "standup", "one-on-one", "retrospective"];

/** The part of `Storage` this needs, so a test can hand it a plain object. */
export interface LegacyDraftStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/**
 * Read the legacy draft and remove it, in that order and with no condition
 * between them.
 *
 * The removal is deliberately not in the success branch: three of the four
 * shapes this key can hold (a value from an older build, a malformed one, one
 * whose fields are the wrong types) parse to `null`, and gating the delete on a
 * successful parse is what kept them.
 */
export function takeLegacyDraft(storage: LegacyDraftStorage): MeetingComposeDraft | null {
  let raw: string | null;
  try { raw = storage.getItem(LEGACY_DRAFT_KEY); }
  catch { return null; }
  try { storage.removeItem(LEGACY_DRAFT_KEY); }
  catch { /* a store that refuses a delete is not one this can fix */ }
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as { title?: unknown; transcript?: unknown; template?: unknown; language?: unknown } | null;
    const title = typeof saved?.title === "string" ? saved.title : "";
    const transcript = typeof saved?.transcript === "string" ? saved.transcript : "";
    if (!title && !transcript) return null;
    const template = TEMPLATES.find((candidate) => candidate === saved?.template);
    const language = typeof saved?.language === "string" && saved.language.trim() ? saved.language.trim() : undefined;
    return { title, transcript, ...(template ? { template } : {}), ...(language ? { language } : {}) };
  } catch { return null; }
}

/**
 * Move the legacy draft into the protected file, and answer with whatever could
 * not be moved.
 *
 * `null` means there is nothing left over: either there was no draft, or it is
 * now in the host's `0600` file where the next compose form will read it. A
 * returned draft is one the words came out of `localStorage` for and had nowhere
 * durable to go, so the form restores it from memory instead — the user still
 * has it this session, and it is no longer in a store any page script can read.
 */
export async function migrateLegacyDraft(
  capture: MeetingCaptureOps,
  storage: LegacyDraftStorage | null = typeof localStorage === "undefined" ? null : localStorage,
): Promise<MeetingComposeDraft | null> {
  if (!storage) return null;
  const draft = takeLegacyDraft(storage);
  if (!draft) return null;
  // A preload with no draft channel would accept this write and do nothing with
  // it, which is indistinguishable from success at the call site and would end
  // with the words deleted from one store and absent from the other.
  if (!capture.draftAvailable) return draft;
  try {
    // The protected file wins when it holds anything at all: it can only have
    // been written since the upgrade, so it is newer than whatever this key was
    // still carrying, and overwriting it would restore an older draft over the
    // one the user last typed.
    if (await capture.readDraft()) return null;
    await capture.writeDraft(draft);
    return null;
  } catch {
    return draft;
  }
}

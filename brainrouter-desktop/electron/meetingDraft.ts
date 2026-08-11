/**
 * ADR-035 D6 — the compose draft, in the protected location the audio already
 * lives in.
 *
 * D6 says it in one sentence: "**Audio is never written to `localStorage` or any
 * renderer-accessible store.** The existing text draft should move to the same
 * protected location for the same reason." It had not moved. The draft was
 * `brainrouter:desktop-meeting-draft` in `localStorage`, written from the
 * renderer — and once D4 started folding live transcript into the compose box,
 * that draft filled up with the recorded meeting's actual words. The store any
 * page script can read became the second copy of the meeting.
 *
 * So this module owns the draft file: one JSON record inside the `0700` capture
 * directory, written `0600`, reachable only through the same IPC bridge the
 * audio crosses. It is deliberately a SIBLING of the per-capture directories
 * rather than one of them — `MeetingCaptureStore.storedIds` only ever looks at
 * directories whose name is a valid session id, so this file is invisible to the
 * boot pass, the reap and the recovery offer, and cannot be mistaken for a
 * capture that lost its audio.
 *
 * Invariants:
 *
 * 1. **One draft, rewritten in place.** There is a single compose form, so there
 *    is a single draft; the file is replaced, never appended to, which is what
 *    keeps an autosave on every keystroke from growing anything.
 * 2. **Temp-then-rename.** A crash mid-write leaves the previous draft intact
 *    rather than a truncated one that reads as no draft at all.
 * 3. **A record that cannot be read is no draft.** Every field is re-validated on
 *    the way out: this file outlives app versions, and a surface that trusted its
 *    shape would render whatever the last version happened to write.
 * 4. **This file holds the compose box, whole.** The renderer used to strip the
 *    live capture's settled segments out first, so that the meeting's words were
 *    not mirrored into a restorable store — a rule that made sense while the
 *    draft was in `localStorage` and stopped making sense the moment it moved
 *    here, into the `0700` directory the audio itself lives in. What it left
 *    behind was worse than what it prevented: a draft that no longer said what
 *    the box said, so restoring it and reconciling it against the same session
 *    produced a doubled edit, an undone deletion, a relocated note, or — when a
 *    kept line happened to match a later segment — a silently truncated meeting.
 *    A draft is a copy of the form; anything else is a different document
 *    wearing the same name.
 *
 * Like `meetingCapture.ts`, it does not import `electron`: the channels are in
 * `meetingCaptureChannels.ts` so the mode guarantee can be checked against a
 * temporary directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MeetingCaptureTemplate } from '@kinqs/brainrouter-core/meetings';
import { MEETING_CAPTURE_DIRECTORY } from './meetingCapture.js';

const DRAFT_FILE = 'compose-draft.json';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const TEMPLATES: readonly MeetingCaptureTemplate[] = ['general', 'standup', 'one-on-one', 'retrospective'];

/**
 * What the compose form is holding that is not audio: the title, the pasted or
 * typed transcript, and the two choices that describe how it will be summarized.
 */
export interface MeetingComposeDraft {
  readonly title: string;
  readonly transcript: string;
  readonly template?: MeetingCaptureTemplate;
  readonly language?: string;
}

/**
 * `version` for the same reason the capture record carries one: this file
 * outlives app versions, and a format change needs somewhere to say so. There is
 * deliberately no saved-at field — the filesystem already records when this was
 * written, and a second copy of that fact would be one nothing reads.
 */
interface StoredDraft {
  readonly version: 1;
  readonly draft: MeetingComposeDraft;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The one shape a caller may hand in, with everything else dropped. */
export function normalizeComposeDraft(value: unknown): MeetingComposeDraft {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const template = string(raw.template);
  const language = string(raw.language).trim();
  return {
    title: string(raw.title),
    transcript: string(raw.transcript),
    ...(TEMPLATES.includes(template as MeetingCaptureTemplate) ? { template: template as MeetingCaptureTemplate } : {}),
    ...(language ? { language } : {}),
  };
}

export class MeetingDraftStore {
  private readonly root: string;

  constructor(userDataPath: string) {
    this.root = path.join(userDataPath, MEETING_CAPTURE_DIRECTORY);
  }

  /** The saved draft, or `null` when there is none and when there is nothing worth restoring. */
  async read(): Promise<MeetingComposeDraft | null> {
    let raw: string;
    try { raw = await fs.promises.readFile(this.file(), 'utf8'); }
    catch { return null; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    const stored = value && typeof value === 'object' ? (value as Partial<StoredDraft>).draft : null;
    const draft = normalizeComposeDraft(stored);
    // An empty draft is not a draft: restoring one would light the "Draft
    // recovered" badge over a form with nothing in it, which is the kind of
    // true-but-misleading surface ADR-028 asks us not to build.
    return draft.title || draft.transcript ? draft : null;
  }

  async write(draft: MeetingComposeDraft): Promise<void> {
    const normalized = normalizeComposeDraft(draft);
    if (!normalized.title && !normalized.transcript) {
      await this.clear();
      return;
    }
    await fs.promises.mkdir(this.root, { recursive: true, mode: DIRECTORY_MODE });
    await this.chmodQuiet(this.root, DIRECTORY_MODE);
    const file = this.file();
    const temporary = `${file}.${process.pid}.tmp`;
    const payload: StoredDraft = { version: 1, draft: normalized };
    await fs.promises.writeFile(temporary, `${JSON.stringify(payload)}\n`, { mode: FILE_MODE });
    await this.chmodQuiet(temporary, FILE_MODE);
    await fs.promises.rename(temporary, file);
  }

  /** The meeting was created, or the form was emptied. The words stop existing here. */
  async clear(): Promise<void> {
    await fs.promises.rm(this.file(), { force: true });
  }

  private file(): string {
    return path.join(this.root, DRAFT_FILE);
  }

  /** Windows has no POSIX modes; the security property is a POSIX one, so a failure there is not an error. */
  private async chmodQuiet(target: string, mode: number): Promise<void> {
    try { await fs.promises.chmod(target, mode); } catch { /* Windows */ }
  }
}

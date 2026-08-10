/**
 * ADR-035 D1/D2/D3 — the IPC surface over the meeting capture store and the
 * host-owned transcription queue.
 *
 * The renderer has no filesystem, so every byte of meeting audio crosses this
 * boundary on its way to disk. That is the whole reason the channels exist:
 * `ondataavailable` fires in the renderer and the durable write has to happen in
 * a process that outlives a renderer crash, which is main.
 *
 * Transcription is on this side for the same reason (open question 3): "a
 * renderer-owned queue dies with the window, which is the defect this ADR exists
 * to fix". The renderer therefore asks for two things only — start transcribing
 * this capture, retry this segment — and is TOLD about progress on a push
 * channel, so a window that reloads mid-meeting rejoins a queue that never
 * stopped instead of restarting one.
 *
 * The handlers do nothing but validate and delegate. Validation is not
 * ceremony — a compromised or merely buggy renderer supplies these arguments,
 * and the store turns a session id into a directory path, so a non-string id has
 * to be refused here rather than discovered by `path.join`.
 *
 * The compose DRAFT crosses here for a different reason and the same rule: D6
 * asks that it move out of `localStorage` into the protected location the audio
 * already lives in, so the renderer asks the host to hold it too
 * (`meetingDraft.ts`).
 *
 * Registration also runs the one boot recovery pass (D2/D6): a session left
 * `recording` by a crash is corrected, and capture directories no record claims
 * are reaped and logged.
 */
import { BrowserWindow, app, ipcMain } from 'electron';
import type { MeetingCaptureScope, MeetingCaptureTemplate } from '@kinqs/brainrouter-core/meetings';
import { MeetingCaptureStore } from './meetingCapture.js';
import { MeetingDraftStore, normalizeComposeDraft } from './meetingDraft.js';
import { MeetingTranscriptionSupervisor, type MeetingCaptureProgress } from './meetingTranscription.js';
import { transcribeCaptureSegment } from './meetingsBridge.js';

const TEMPLATES: readonly MeetingCaptureTemplate[] = ['general', 'standup', 'one-on-one', 'retrospective'];

/** D4's push channel: a capture's record changed, and it is already on disk. */
export const MEETING_CAPTURE_PROGRESS_CHANNEL = 'meetings:capture-progress';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireId(value: unknown): string {
  const id = text(value);
  if (!id) throw new Error('A meeting capture id is required.');
  return id;
}

/** Segment indices name files, so anything that is not a whole number is refused. */
function requireIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('A meeting segment index is required.');
  }
  return value;
}

/** Chrome hands `ondataavailable` an ArrayBuffer; structured clone may deliver either shape. */
function requireBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('A meeting capture chunk must be binary audio.');
}

function scopeOf(value: unknown): MeetingCaptureScope {
  const raw = value && typeof value === 'object' ? value as { orgId?: unknown; workspaceId?: unknown } : {};
  return { orgId: text(raw.orgId) ?? null, workspaceId: text(raw.workspaceId) ?? null };
}

/**
 * D6 — the window on the other end of this call, as the capture lease names it.
 *
 * The id is minted in the renderer (one module-level constant per BrowserWindow
 * — see `captureHolder.ts`) and threaded through every capture channel, because
 * the id has to be the SAME one on the surface and in the record: the compose
 * form asks `describeCaptureWriter(session, myHolderId)` whether the writer is
 * itself, and a host-minted id the renderer could not name would make that
 * question unanswerable. It is not a security boundary and does not pretend to
 * be one — every window here is our own code and the capture directory is 0700.
 * What it is is a coordination token, and an absent one is treated as "this
 * caller will not say", which leaves the transition to refuse for any live
 * writer at all rather than exempting an anonymous one.
 */
function holderOf(value: unknown): string | undefined {
  return text(value);
}

/**
 * Progress goes to every window rather than to the one that pressed Record.
 *
 * A capture belongs to the process, not to a window: the window that started it
 * may have been reloaded or closed, and the one the user is looking at now is
 * the one that has to show the text (ADR-029 — one workspace, many surfaces).
 */
function broadcast(progress: MeetingCaptureProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(MEETING_CAPTURE_PROGRESS_CHANNEL, progress);
  }
}

export function registerMeetingCaptureBridge(userDataPath = app.getPath('userData')): MeetingCaptureStore {
  const store = new MeetingCaptureStore(userDataPath);
  const drafts = new MeetingDraftStore(userDataPath);
  const supervisor = new MeetingTranscriptionSupervisor(store, {
    transcribe: transcribeCaptureSegment,
    publish: broadcast,
  });

  void store.recoverInterrupted().then((report) => {
    if (report.recovered.length) console.warn(`[meetings] recovered ${report.recovered.length} interrupted capture(s).`);
    // §6 asks that "the audio up to the kill" be there, and the chunk a kill
    // landed on top of is the one that is easiest to lose and hardest to notice
    // losing. Logged separately from the reap so it is visible that the boot
    // pass rescued audio rather than only deleting things.
    if (report.adopted.length) console.warn(`[meetings] adopted a durable chunk the record had not claimed in ${report.adopted.length} capture(s).`);
    // D6 asks for the reap to be logged: a capture directory nobody will ever be
    // offered is exactly the artifact nobody would otherwise notice. The wording
    // covers all three cases the store reaps — no record, a record that is
    // already terminal because a kill interrupted the delete, and a Record that
    // died before its first chunk — because claiming they were all orphans would
    // be a guess.
    if (report.reaped.length) console.warn(`[meetings] reaped ${report.reaped.length} capture director(ies) holding no recoverable audio.`);
  }).catch((caught: unknown) => {
    console.warn('[meetings] capture recovery failed:', caught instanceof Error ? caught.message : caught);
  });

  ipcMain.handle('meetings:captureBegin', async (_event, input: unknown) => {
    const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const template = text(raw.template);
    const holderId = holderOf(raw.holderId);
    return await supervisor.begin({
      scope: scopeOf(raw),
      ...(text(raw.title) ? { title: text(raw.title)! } : {}),
      ...(template && TEMPLATES.includes(template as MeetingCaptureTemplate) ? { template: template as MeetingCaptureTemplate } : {}),
      ...(text(raw.language) ? { language: text(raw.language)! } : {}),
      ...(text(raw.contentType) ? { contentType: text(raw.contentType)! } : {}),
      // The label is what ANOTHER window will read off this record, so it is
      // written from that window's point of view rather than this one's.
      ...(holderId ? { holder: { holderId, holder: 'Another window' } } : {}),
    });
  });

  ipcMain.handle('meetings:captureAppend', async (_event, id: unknown, bytes: unknown, durationMs: unknown) => {
    const elapsed = typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : 0;
    // A chunk that measured as instant is still a chunk of audio; clamping to
    // one millisecond keeps the shared model's positive-duration rule from
    // rejecting bytes that are already worth keeping.
    return await supervisor.append(requireId(id), requireBytes(bytes), Math.max(1, Math.round(elapsed)));
  });

  ipcMain.handle('meetings:captureStop', async (_event, id: unknown) => await supervisor.stop(requireId(id)));
  ipcMain.handle('meetings:captureRead', async (_event, id: unknown) => await store.read(requireId(id)));
  // D3 — "transcribe this capture" no longer means "post the whole thing". It
  // means: this process should be draining it, segment by segment, from here on.
  ipcMain.handle('meetings:captureAdopt', async (_event, id: unknown, holderId: unknown) => {
    const holder = holderOf(holderId);
    return await supervisor.adopt(requireId(id), holder ? { holderId: holder, holder: 'Another window' } : undefined);
  });
  ipcMain.handle('meetings:captureRetrySegment', async (_event, id: unknown, index: unknown) =>
    await supervisor.retry(requireId(id), requireIndex(index)));
  // D6 — both of these DELETE the audio, so both name the window asking. Without
  // the actor the shared transition has no way to tell the window that recorded
  // this meeting from a second one that is merely looking at a stale offer, and
  // it has to refuse for either or neither.
  ipcMain.handle('meetings:captureFinalize', async (_event, id: unknown, holderId: unknown) => {
    const holder = holderOf(holderId);
    await supervisor.close(requireId(id), 'finalize', holder ? { holderId: holder } : undefined);
    return { ok: true };
  });
  ipcMain.handle('meetings:captureDiscard', async (_event, id: unknown, holderId: unknown) => {
    const holder = holderOf(holderId);
    await supervisor.close(requireId(id), 'discard', holder ? { holderId: holder } : undefined);
    return { ok: true };
  });
  ipcMain.handle('meetings:captureResumable', async (_event, scope: unknown) => await store.resumable(scopeOf(scope)));
  // D6 — the complement of `captureResumable`: what a surface must say instead of
  // offering a live recording back. A window that only ever learns about its OWN
  // capture has nothing to print here, which is the defect the lease replaced.
  ipcMain.handle('meetings:captureWriting', async (_event, scope: unknown) => await store.writing(scopeOf(scope)));

  // D6 — the compose draft. It used to be written to `localStorage` from the
  // renderer, which is the store D6 names ("any page script can read") and which
  // filled up with the recorded meeting's own words once D4 started folding live
  // transcript into the box. The words now live where the audio does.
  ipcMain.handle('meetings:draftRead', async () => await drafts.read());
  ipcMain.handle('meetings:draftWrite', async (_event, draft: unknown) => {
    await drafts.write(normalizeComposeDraft(draft));
    return { ok: true };
  });
  ipcMain.handle('meetings:draftClear', async () => {
    await drafts.clear();
    return { ok: true };
  });

  // Timers only; the audio and the record are already on disk, so quitting mid
  // drain costs the remaining segments a retry and nothing else.
  app.once('will-quit', () => supervisor.dispose());

  return store;
}

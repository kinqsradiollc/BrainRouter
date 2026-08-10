/**
 * ADR-035 D1/D2 — the IPC surface over the meeting capture store.
 *
 * The renderer has no filesystem, so every byte of meeting audio crosses this
 * boundary on its way to disk. That is the whole reason the channels exist:
 * `ondataavailable` fires in the renderer and the durable write has to happen in
 * a process that outlives a renderer crash, which is main.
 *
 * The handlers do nothing but validate and delegate. Validation is not
 * ceremony — a compromised or merely buggy renderer supplies these arguments,
 * and the store turns a session id into a directory path, so a non-string id has
 * to be refused here rather than discovered by `path.join`.
 *
 * Registration also runs the one boot recovery pass (D2/D6): a session left
 * `recording` by a crash is corrected, and capture directories no record claims
 * are reaped and logged.
 */
import { app, ipcMain } from 'electron';
import type { MeetingCaptureScope, MeetingCaptureTemplate } from '@kinqs/brainrouter-core/meetings';
import { MeetingCaptureStore } from './meetingCapture.js';

const TEMPLATES: readonly MeetingCaptureTemplate[] = ['general', 'standup', 'one-on-one', 'retrospective'];

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireId(value: unknown): string {
  const id = text(value);
  if (!id) throw new Error('A meeting capture id is required.');
  return id;
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

export function registerMeetingCaptureBridge(userDataPath = app.getPath('userData')): MeetingCaptureStore {
  const store = new MeetingCaptureStore(userDataPath);

  void store.recoverInterrupted().then((report) => {
    if (report.recovered.length) console.warn(`[meetings] recovered ${report.recovered.length} interrupted capture(s).`);
    // D6 asks for the reap to be logged: a directory holding audio no session
    // claims is exactly the artifact nobody would otherwise notice.
    if (report.reaped.length) console.warn(`[meetings] reaped ${report.reaped.length} orphaned capture director(ies).`);
  }).catch((caught: unknown) => {
    console.warn('[meetings] capture recovery failed:', caught instanceof Error ? caught.message : caught);
  });

  ipcMain.handle('meetings:captureBegin', async (_event, input: unknown) => {
    const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const template = text(raw.template);
    return await store.begin({
      scope: scopeOf(raw),
      ...(text(raw.title) ? { title: text(raw.title)! } : {}),
      ...(template && TEMPLATES.includes(template as MeetingCaptureTemplate) ? { template: template as MeetingCaptureTemplate } : {}),
      ...(text(raw.language) ? { language: text(raw.language)! } : {}),
      ...(text(raw.contentType) ? { contentType: text(raw.contentType)! } : {}),
    });
  });

  ipcMain.handle('meetings:captureAppend', async (_event, id: unknown, bytes: unknown, durationMs: unknown) => {
    const elapsed = typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : 0;
    // A chunk that measured as instant is still a chunk of audio; clamping to
    // one millisecond keeps the shared model's positive-duration rule from
    // rejecting bytes that are already worth keeping.
    return await store.append(requireId(id), requireBytes(bytes), Math.max(1, Math.round(elapsed)));
  });

  ipcMain.handle('meetings:captureStop', async (_event, id: unknown) => await store.stop(requireId(id)));
  ipcMain.handle('meetings:captureRead', async (_event, id: unknown) => await store.read(requireId(id)));
  ipcMain.handle('meetings:captureFinalize', async (_event, id: unknown) => {
    await store.finalize(requireId(id));
    return { ok: true };
  });
  ipcMain.handle('meetings:captureDiscard', async (_event, id: unknown) => {
    await store.discard(requireId(id));
    return { ok: true };
  });
  ipcMain.handle('meetings:captureResumable', async (_event, scope: unknown) => await store.resumable(scopeOf(scope)));

  return store;
}

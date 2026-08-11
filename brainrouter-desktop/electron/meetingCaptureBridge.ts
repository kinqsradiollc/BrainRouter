/**
 * ADR-035 D1/D2/D3/D6 — the Electron adapter under the meeting-capture wire.
 *
 * ## What it owns
 *
 * The three things only Electron can give the channels in
 * `meetingCaptureChannels.ts`: `ipcMain.handle`, a push to every live
 * `webContents`, and the lifetime of the window behind a call. Nothing about
 * WHAT a channel does is decided here — that moved out, because every
 * `holderId` thread through this file could be deleted with the whole repository
 * green, and the only test that touched it read it as source text.
 *
 * ## Why the store and the queue are in main at all
 *
 * The renderer has no filesystem, so every byte of meeting audio crosses this
 * boundary on its way to disk: `ondataavailable` fires in the renderer and the
 * durable write has to happen in a process that outlives a renderer crash.
 * Transcription is on this side for the same reason (open question 3): "a
 * renderer-owned queue dies with the window, which is the defect this ADR exists
 * to fix". The renderer therefore asks for two things only — start transcribing
 * this capture, retry this segment — and is TOLD about progress on a push
 * channel, so a window that reloads mid-meeting rejoins a queue that never
 * stopped instead of restarting one.
 *
 * ## What `watchCaller` is for, and what it is not
 *
 * D6 — a window that was recording and is now gone must stop being the writer of
 * its capture. The page reports that itself on `pagehide` (see `preload.cts`),
 * which covers a reload, a navigation and an ordinary close; this covers the one
 * a page cannot report, which is its renderer dying. Both end in the same
 * idempotent release. Neither is a timer, and there is no staleness threshold
 * anywhere in the path: main is the process every BrowserWindow lives in, so it
 * knows the answer rather than inferring it.
 */
import { BrowserWindow, app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { MeetingCaptureStore } from './meetingCapture.js';
import {
  registerMeetingCaptureChannels,
  MEETING_CAPTURE_PROGRESS_CHANNEL,
  type MeetingCaptureChannelHost,
} from './meetingCaptureChannels.js';
import { MeetingDraftStore } from './meetingDraft.js';
import { MeetingTranscriptionSupervisor } from './meetingTranscription.js';
import { transcribeCaptureSegment } from './meetingsBridge.js';

export { MEETING_CAPTURE_PROGRESS_CHANNEL, MEETING_CAPTURE_WRITERS_CHANNEL } from './meetingCaptureChannels.js';

/**
 * Pushes go to every window rather than to the one that caused them.
 *
 * A capture belongs to the process, not to a window: the window that started it
 * may have been reloaded or closed, and the one the user is looking at now is
 * the one that has to show the text (ADR-029 — one workspace, many surfaces).
 */
function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function senderOf(caller: unknown): WebContents | null {
  const event = caller as IpcMainInvokeEvent | undefined;
  const sender = event?.sender;
  return sender && !sender.isDestroyed() ? sender : null;
}

const electronHost: MeetingCaptureChannelHost = {
  handle: (channel, listener) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => await listener(event, ...args));
  },
  broadcast,
  watchCaller: (caller, gone) => {
    const sender = senderOf(caller);
    // A caller whose webContents is already destroyed is one whose window is
    // gone: reporting it now is right, and the alternative is a claim nothing
    // will ever remove.
    if (!sender) { gone(); return; }
    sender.once('destroyed', gone);
    sender.once('render-process-gone', gone);
  },
};

export function registerMeetingCaptureBridge(userDataPath = app.getPath('userData')): MeetingCaptureStore {
  const store = new MeetingCaptureStore(userDataPath);
  const drafts = new MeetingDraftStore(userDataPath);
  const supervisor = new MeetingTranscriptionSupervisor(store, {
    transcribe: transcribeCaptureSegment,
    publish: (progress) => { broadcast(MEETING_CAPTURE_PROGRESS_CHANNEL, progress); },
  });

  registerMeetingCaptureChannels(electronHost, { store, drafts, supervisor });

  // Timers only; the audio and the record are already on disk, so quitting mid
  // drain costs the remaining segments a retry and nothing else.
  app.once('will-quit', () => supervisor.dispose());

  return store;
}

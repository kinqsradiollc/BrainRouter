/**
 * ADR-035 D1/D2/D3/D6 — the meeting-capture wire: every channel the renderer can
 * call, and what each one does to the store, the queue and the writer registry.
 *
 * ## What it owns
 *
 * The BEHAVIOUR of the boundary, with no Electron in it. `meetingCaptureBridge.ts`
 * is the adapter that supplies `ipcMain`, `BrowserWindow` and a real `WebContents`
 * lifetime; everything a caller can get wrong lives here, where a test can drive
 * it.
 *
 * That split is not tidiness. All four `holderId` threads through the previous
 * single file could be deleted with the whole repository green: delete one and no
 * capture is ever claimed, every "is somebody recording?" answers no, and D6
 * becomes inert with nothing to notice it. The only test that touched the bridge
 * read it as SOURCE TEXT and enumerated channel names — which cannot see whether
 * an argument reaches anything. So the wire moved to a module that imports no
 * `electron`, and `meetingCaptureChannels.test.ts` invokes the channels.
 *
 * ## Why the renderer has to say who it is
 *
 * The renderer has no filesystem, so every byte of meeting audio crosses this
 * boundary on its way to disk, and the durable write has to happen in a process
 * that outlives a renderer crash — which is main. Main therefore holds captures
 * from EVERY window, and the four channels that take or release a recording
 * (`captureBegin`, `captureAdopt`, `captureFinalize`, `captureDiscard`) carry the
 * calling window's holder id so the supervisor can tell the window that is
 * recording a meeting from a second one looking at a stale offer. It is a
 * coordination token and not a credential: every window here is our own code and
 * the capture directory is `0700`.
 *
 * ## The two pushes
 *
 * - **Progress** (D4): a capture's record changed and is already on disk.
 * - **Writers** (D6): the set of captures being recorded into changed — a Record,
 *   a Stop, a close, or a window going away. It carries no payload; a surface
 *   asks again, because the answer it needs is scoped to its own workspace and
 *   its own holder id. This is what replaced "schedule a refresh for when the
 *   lease lapses": there is no lapse to wait for, so the surface is told at the
 *   instant it becomes wrong, which is the only moment that was ever right.
 *
 * ## Registration also runs the one boot pass
 *
 * D2/D6 — a session left `recording` by a crash is corrected, a chunk the kill
 * landed on top of is adopted, and capture directories no record claims are
 * reaped and logged. It runs here, before any window can press Record, and it is
 * handed the supervisor's liveness predicate rather than reading one off the
 * record.
 *
 * ## …and the retention sweep, which is not the same pass
 *
 * D6's third deletion trigger deletes audio a person still WANTED offered back
 * yesterday, so it is chained after recovery rather than folded into it: the
 * reap decides from what a directory contains, the sweep from how old a
 * capture's record says it is, and running the second over records the first is
 * still rewriting would age a capture by a date about to change. It runs at
 * registration, before every recovery offer, and the instant the window is
 * changed — three moments, no timer, and the same liveness predicate every
 * destructive pass here takes.
 */
import {
  describeMeetingRetention,
  MEETING_RETENTION_DAY_CHOICES,
  normalizeMeetingRetentionDays,
  type MeetingCaptureScope,
  type MeetingCaptureTemplate,
} from '@kinqs/brainrouter-core/meetings';
import type { MeetingCaptureStore } from './meetingCapture.js';
import { normalizeComposeDraft, type MeetingDraftStore } from './meetingDraft.js';
import type { MeetingTranscriptionSupervisor } from './meetingTranscription.js';

const TEMPLATES: readonly MeetingCaptureTemplate[] = ['general', 'standup', 'one-on-one', 'retrospective'];

/** D4's push channel: a capture's record changed, and it is already on disk. */
export const MEETING_CAPTURE_PROGRESS_CHANNEL = 'meetings:capture-progress';

/** D6's push channel: the set of captures being recorded into changed. Ask again. */
export const MEETING_CAPTURE_WRITERS_CHANNEL = 'meetings:capture-writers';

/**
 * What the host lends this module: a way to answer calls, a way to push, and a
 * way to learn that a window is gone.
 *
 * `caller` is opaque on purpose — it is Electron's `IpcMainInvokeEvent` in the
 * app and a plain marker in a test. Nothing here inspects it; it is only ever
 * handed back to `watchCaller`.
 */
export interface MeetingCaptureChannelHost {
  /** Register an invokable channel. A rejection reaches the renderer as a rejected promise. */
  handle(channel: string, listener: (caller: unknown, ...args: unknown[]) => unknown): void;
  /** Push to every window, including the one that caused it. */
  broadcast(channel: string, payload: unknown): void;
  /**
   * D6 — run `gone` once the page behind this call is destroyed or its renderer
   * dies.
   *
   * The backstop under the renderer's own `pagehide` report: a window that
   * crashed never gets to say anything, and a recording it was making must stop
   * being claimed anyway. Both paths end in `releaseWindow`, which is idempotent.
   */
  watchCaller(caller: unknown, gone: () => void): void;
}

export interface MeetingCaptureChannelParts {
  readonly store: MeetingCaptureStore;
  readonly drafts: MeetingDraftStore;
  readonly supervisor: MeetingTranscriptionSupervisor;
  /** Where the boot pass reports. Injected so a test can read it instead of the terminal. */
  readonly warn?: (message: string) => void;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requireId(value: unknown): string {
  const id = text(value);
  if (!id) throw new Error('A meeting capture id is required.');
  return id;
}

/** Retry targets are transcription-unit indices, so only non-negative whole numbers cross IPC. */
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
 * D6 — the window on the other end of this call.
 *
 * The id is minted in the renderer (one module-level constant per BrowserWindow
 * — see `captureHolder.ts`) and threaded through every channel that takes or
 * releases a recording, because the id has to be the SAME one on the surface and
 * in the supervisor: the compose form asks whether the writer of a capture is
 * itself, and a host-minted id the renderer could not name would make that
 * question unanswerable. An absent one is treated as "this caller will not say",
 * which leaves the guard to refuse for any live writer at all rather than
 * exempting an anonymous one.
 */
function holderOf(value: unknown): string | undefined {
  return text(value);
}

export function registerMeetingCaptureChannels(
  host: MeetingCaptureChannelHost,
  parts: MeetingCaptureChannelParts,
): void {
  const { store, drafts, supervisor } = parts;
  const warn = parts.warn ?? ((message: string) => { console.warn(message); });
  /** D6 — "the live set changed"; every window asks again, with its own scope and id. */
  const announce = (): void => { host.broadcast(MEETING_CAPTURE_WRITERS_CHANNEL, {}); };

  // Every capture channel waits on this ONE pass. Registration itself cannot
  // await, and without a shared gate a window can read/adopt a stale manifest
  // while reconciliation is rewriting it. The rejection is handled here so a
  // failed recovery is visible but never leaves every capture IPC deadlocked.
  const bootRecovery = store.recoverInterrupted({
    // D6 — the boot pass rewrites records, adopts chunk files and deletes
    // directories, and none of that is right for a capture being recorded into.
    // It runs before any window can press Record, so this is empty in practice —
    // and passing it is what keeps that true by construction rather than by the
    // order two lines happen to be in.
    isWriting: (id) => supervisor.isWriting(id),
  }).then((report) => {
    if (report.recovered.length) warn(`[meetings] recovered ${report.recovered.length} interrupted capture(s).`);
    // §6 asks that "the audio up to the kill" be there, and the chunk a kill
    // landed on top of is the one that is easiest to lose and hardest to notice
    // losing. Logged separately from the reap so it is visible that the boot
    // pass rescued audio rather than only deleting things.
    if (report.adopted.length) warn(`[meetings] adopted a durable chunk the record had not claimed in ${report.adopted.length} capture(s).`);
    // D6 asks for the reap to be logged: a capture directory nobody will ever be
    // offered is exactly the artifact nobody would otherwise notice. The wording
    // covers all three cases the store reaps — no record, a record that is
    // already terminal because a kill interrupted the delete, and a Record that
    // died before its first chunk — because claiming they were all orphans would
    // be a guess.
    if (report.reaped.length) warn(`[meetings] reaped ${report.reaped.length} capture director(ies) holding no recoverable audio.`);
  }).catch((caught: unknown) => {
    warn(`[meetings] capture recovery failed: ${caught instanceof Error ? caught.message : String(caught)}`);
  }).then(() => sweepRetention());

  /**
   * D6 — delete what has outlived the window, and say how much.
   *
   * Chained after the boot pass rather than beside it because both walk the same
   * directory and the recovery pass REWRITES records: a sweep reading a capture
   * half-way through its reconciliation would age it by a date that is about to
   * change. Its own failure is logged and swallowed for the same reason the
   * recovery's is — a store that cannot be swept must not leave every capture
   * IPC deadlocked behind it.
   *
   * It runs here and before every recovery offer, and that pair is deliberate:
   * boot covers the app that is opened once a week, and the offer covers the one
   * that is left running for a month. Neither is a timer, so there is no
   * schedule to drift and nothing deleting audio while nobody is looking at the
   * app at all.
   */
  async function sweepRetention(): Promise<void> {
    try {
      const days = await store.retentionDays();
      const deleted = await store.sweepExpired({ days, isWriting: (id) => supervisor.isWriting(id) });
      // D6 asks for the reap to be logged, and this deletes MORE than the reap
      // does — a reaped directory held nothing anyone would be offered, while
      // this one held a whole recording that simply got old. Silence about that
      // would be the retention incident, not the fix for it.
      if (deleted.length) warn(`[meetings] deleted ${deleted.length} capture(s) older than the ${days}-day retention window.`);
    } catch (caught) {
      warn(`[meetings] retention sweep failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  }

  host.handle('meetings:captureBegin', async (caller, input: unknown) => {
    await bootRecovery;
    const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const template = text(raw.template);
    const holderId = holderOf(raw.holderId);
    const session = await supervisor.begin({
      scope: scopeOf(raw),
      ...(text(raw.title) ? { title: text(raw.title)! } : {}),
      ...(template && TEMPLATES.includes(template as MeetingCaptureTemplate) ? { template: template as MeetingCaptureTemplate } : {}),
      ...(text(raw.language) ? { language: text(raw.language)! } : {}),
      ...(text(raw.contentType) ? { contentType: text(raw.contentType)! } : {}),
      ...(holderId ? { writerId: holderId } : {}),
    });
    // D6 — the window that started a recording is the window whose death ends
    // it. Registered on the call that CREATED the claim, so there is no window
    // in which a capture is claimed by a page nothing is watching.
    if (holderId) host.watchCaller(caller, () => { release(holderId); });
    announce();
    return session;
  });

  host.handle('meetings:captureAppend', async (_caller, id: unknown, bytes: unknown, durationMs: unknown) => {
    await bootRecovery;
    const elapsed = typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : 0;
    // A chunk that measured as instant is still a chunk of audio; clamping to
    // one millisecond keeps the shared model's positive-duration rule from
    // rejecting bytes that are already worth keeping.
    return await supervisor.append(requireId(id), requireBytes(bytes), Math.max(1, Math.round(elapsed)));
  });

  host.handle('meetings:captureStop', async (_caller, id: unknown) => {
    await bootRecovery;
    const session = await supervisor.stop(requireId(id));
    // The recording ended, so every other window's offer and every disabled
    // destructive control is now wrong. This is what a lease made a surface wait
    // out a staleness window for.
    announce();
    return session;
  });

  host.handle('meetings:captureRead', async (_caller, id: unknown) => {
    await bootRecovery;
    return await store.read(requireId(id));
  });
  // D3 — "transcribe this capture" no longer means "post the whole thing". It
  // means: this process should be draining it, segment by segment, from here on.
  host.handle('meetings:captureAdopt', async (_caller, id: unknown, holderId: unknown) => {
    await bootRecovery;
    return await supervisor.adopt(requireId(id), holderOf(holderId));
  });
  host.handle('meetings:captureRetrySegment', async (_caller, id: unknown, index: unknown) => {
    await bootRecovery;
    return await supervisor.retry(requireId(id), requireIndex(index));
  });
  // D6 — both of these DELETE the audio, so both name the window asking. Without
  // the actor the supervisor has no way to tell the window that recorded this
  // meeting from a second one that is merely looking at a stale offer, and it
  // would have to refuse for either or neither.
  host.handle('meetings:captureFinalize', async (_caller, id: unknown, holderId: unknown) => {
    await bootRecovery;
    await supervisor.close(requireId(id), 'finalize', holderOf(holderId));
    announce();
    return { ok: true };
  });
  host.handle('meetings:captureDiscard', async (_caller, id: unknown, holderId: unknown) => {
    await bootRecovery;
    await supervisor.close(requireId(id), 'discard', holderOf(holderId));
    announce();
    return { ok: true };
  });
  host.handle('meetings:captureResumable', async (_caller, scope: unknown) => {
    await bootRecovery;
    // D6 — swept BEFORE the offer is computed, not after. This is the one moment
    // an expired capture would otherwise be put back in front of somebody, and
    // an offer that lists a recording the policy has already condemned is a
    // surface disagreeing with the store about what exists.
    await sweepRetention();
    const offers = await store.resumable(scopeOf(scope));
    // D2/D6 — a recording IN PROGRESS is not an unfinished recording to offer
    // back, and the store cannot tell the difference: `isResumableSession`
    // deliberately does not narrow on `recording` (a clean quit leaves audio
    // that never transcribed), and nothing in the record says who is writing.
    // This process does know, so the filter is here — without it a second
    // window is offered "transcribe it, or delete it" over a meeting whose
    // microphone is open, which is the whole failure D6 is about.
    return offers.filter((offer) => !supervisor.isWriting(offer.sessionId));
  });
  // D6 — the complement of `captureResumable`: what a surface must say instead of
  // offering a live recording back. A window that only ever learns about its OWN
  // capture has nothing to print here, which is the defect this answers.
  host.handle('meetings:captureWriting', async (_caller, scope: unknown) => {
    await bootRecovery;
    return await supervisor.writing(scopeOf(scope));
  });
  /**
   * D6 — that window's page is going away, reported by the page itself.
   *
   * The event a lease could only approximate. A renderer RELOAD leaves main
   * entirely untouched, so a heartbeat main owns never lapses and the recording
   * stays claimed by a page that no longer exists — Transcribe, Create and
   * Delete refused for ever over a recording nobody is making. `pagehide` is the
   * moment the page really is gone, and `watchCaller` above covers the case a
   * page cannot report: its renderer died.
   */
  host.handle('meetings:captureRelease', async (_caller, holderId: unknown) => {
    await bootRecovery;
    const holder = holderOf(holderId);
    if (holder) release(holder);
    return { ok: true };
  });

  /**
   * D6 — the retention window, so a surface can show it.
   *
   * The choices and the sentence come back with the number because both are the
   * SHARED rule's (`retention.ts`), and a host that composed its own wording
   * would be describing a policy the other host enforces differently. `days` is
   * whatever the store will actually sweep by, never the raw stored byte.
   */
  host.handle('meetings:retentionRead', async () => {
    await bootRecovery;
    const days = await store.retentionDays();
    return { days, choices: MEETING_RETENTION_DAY_CHOICES, description: describeMeetingRetention(days) };
  });
  /**
   * D6 — the window the user set, and the sweep it implies, in one call.
   *
   * Swept immediately, because the control that shortens a window is being
   * pressed by somebody who wants audio gone: a setting that only takes effect
   * at the next launch is a promise with a delay in it, and this is the decision
   * about deleting microphone recordings. The answer carries what was deleted so
   * the surface can say it happened rather than implying it.
   */
  host.handle('meetings:retentionWrite', async (_caller, days: unknown) => {
    await bootRecovery;
    const stored = await store.setRetentionDays(normalizeMeetingRetentionDays(days));
    const deleted = await store.sweepExpired({ days: stored, isWriting: (id) => supervisor.isWriting(id) });
    if (deleted.length) {
      warn(`[meetings] deleted ${deleted.length} capture(s) older than the ${stored}-day retention window.`);
      // The offer, and every window's disabled state over it, is now wrong. This
      // is the same push a Stop sends, for the same reason: the set of captures
      // a surface may render just changed underneath it.
      announce();
    }
    return { days: stored, choices: MEETING_RETENTION_DAY_CHOICES, description: describeMeetingRetention(stored), deleted: deleted.length };
  });

  // D6 — the compose draft. It used to be written to `localStorage` from the
  // renderer, which is the store D6 names ("any page script can read") and which
  // filled up with the recorded meeting's own words once D4 started folding live
  // transcript into the box. The words now live where the audio does.
  host.handle('meetings:draftRead', async () => await drafts.read());
  host.handle('meetings:draftWrite', async (_caller, draft: unknown) => {
    await drafts.write(normalizeComposeDraft(draft));
    return { ok: true };
  });
  host.handle('meetings:draftClear', async () => {
    await drafts.clear();
    return { ok: true };
  });

  /** Announce only when something really was released, so a reload of a window with no capture is silent. */
  function release(holderId: string): void {
    if (supervisor.releaseWindow(holderId).length) announce();
  }
}

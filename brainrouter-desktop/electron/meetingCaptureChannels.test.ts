/**
 * ADR-035 D1/D2/D6 — the wire, driven the way a renderer drives it.
 *
 * ## Why this file exists, specifically
 *
 * The bridge was at zero coverage, and the shape of that gap mattered: all four
 * `holderId` threads through it could be deleted with the whole repository
 * green. Delete one and no capture is ever claimed, every "is somebody
 * recording?" answers no, the destructive guards let a second window delete a
 * live meeting — and nothing anywhere fails, because the only test that touched
 * the bridge read it as SOURCE TEXT and enumerated channel names. A regex sees
 * that `holderId` is written; it cannot see that it reaches anything.
 *
 * So these tests invoke the channels. The store and the supervisor are the real
 * ones over a temporary directory; only Electron is faked, because Electron is
 * the part this module deliberately does not have.
 *
 * ## Invariants
 *
 * 1. **Nothing reaches into the supervisor to set up a state.** A capture is
 *    claimed by CALLING `meetings:captureBegin` with a holder id, which is the
 *    only way a window can claim one, and therefore the only way an assertion
 *    about that claim can be true for the right reason.
 * 2. **Two windows are two holder ids.** Which is exactly what they are in the
 *    app: one per BrowserWindow, minted in the renderer.
 * 3. **Every temporary directory is its own.** The store is a directory tree, so
 *    a shared one would make a test's result depend on the order they ran in.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MeetingCaptureSession } from '@kinqs/brainrouter-core/meetings';
import { MeetingCaptureStore, MEETING_CAPTURE_DIRECTORY } from './meetingCapture.js';
import {
  registerMeetingCaptureChannels,
  MEETING_CAPTURE_WRITERS_CHANNEL,
  type MeetingCaptureChannelHost,
} from './meetingCaptureChannels.js';
import { MeetingDraftStore } from './meetingDraft.js';
import { MeetingTranscriptionSupervisor, MEETING_CAPTURE_WRITER_NOTE } from './meetingTranscription.js';

/** One window, as the wire sees it: a marker to identify it and a way to kill it. */
interface Window {
  readonly caller: { readonly id: number };
  /** The holder id this window sends — one per BrowserWindow in the app. */
  readonly holderId: string;
  /** Fire the host's "this window is gone" hook, as a renderer crash does. */
  destroy(): void;
}

interface Wire {
  readonly home: string;
  readonly store: MeetingCaptureStore;
  readonly published: string[];
  window(holderId: string): Window;
  /** Invoke a channel the way `ipcRenderer.invoke` does. */
  call(window: Window | null, channel: string, ...args: unknown[]): Promise<unknown>;
}

function wire(): Wire {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-meeting-wire-'));
  const store = new MeetingCaptureStore(home);
  const supervisor = new MeetingTranscriptionSupervisor(store, { transcribe: async () => 'text' });
  const handlers = new Map<string, (caller: unknown, ...args: unknown[]) => unknown>();
  const published: string[] = [];
  const watchers = new Map<number, (() => void)[]>();
  let nextWindow = 0;

  const host: MeetingCaptureChannelHost = {
    handle: (channel, listener) => {
      assert.equal(handlers.has(channel), false, `${channel} is registered once`);
      handlers.set(channel, listener);
    },
    broadcast: (channel) => { published.push(channel); },
    watchCaller: (caller, gone) => {
      const id = (caller as { id: number }).id;
      watchers.set(id, [...(watchers.get(id) ?? []), gone]);
    },
  };
  registerMeetingCaptureChannels(host, {
    store,
    drafts: new MeetingDraftStore(home),
    supervisor,
    // The boot pass logs; a test that let it reach the terminal would print a
    // recovery report in the middle of the suite for no reason.
    warn: () => undefined,
  });

  return {
    home,
    store,
    published,
    window(holderId) {
      const id = (nextWindow += 1);
      return {
        caller: { id },
        holderId,
        destroy: () => { for (const gone of watchers.get(id) ?? []) gone(); },
      };
    },
    async call(window, channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return await handler(window?.caller ?? { id: 0 }, ...args);
    },
  };
}

/** Press Record in that window, as the renderer's `captureOps` does. */
async function record(harness: Wire, window: Window, over: Record<string, unknown> = {}): Promise<MeetingCaptureSession> {
  const session = await harness.call(window, 'meetings:captureBegin', {
    title: 'Weekly sync', orgId: null, workspaceId: null, holderId: window.holderId, ...over,
  });
  return session as MeetingCaptureSession;
}

function captureDirectory(home: string, id: string): string {
  return path.join(home, MEETING_CAPTURE_DIRECTORY, id);
}

test('the holder id on Record reaches the writer registry, and the one on Delete is compared against it', async () => {
  const harness = wire();
  const first = harness.window('wr-first');
  const second = harness.window('wr-second');
  const session = await record(harness, first);
  await harness.call(first, 'meetings:captureAppend', session.id, new Uint8Array([1, 2]), 20_000);

  // The claim exists BECAUSE the id crossed the wire. Drop it from either end of
  // `captureBegin` and this row is empty — which is precisely what used to be
  // deletable with everything green.
  assert.deepEqual(await harness.call(second, 'meetings:captureWriting', { orgId: null }), [
    { sessionId: session.id, holderId: 'wr-first', note: MEETING_CAPTURE_WRITER_NOTE },
  ]);
  // …and it is not offered back to the second window as an unfinished recording.
  assert.deepEqual(await harness.call(second, 'meetings:captureResumable', { orgId: null }), []);

  // The second window's destructive calls carry ITS id, and are refused.
  await assert.rejects(
    () => harness.call(second, 'meetings:captureDiscard', session.id, second.holderId),
    /recording this meeting right now/,
  );
  await assert.rejects(
    () => harness.call(second, 'meetings:captureFinalize', session.id, second.holderId),
    /recording this meeting right now/,
  );
  await assert.rejects(
    () => harness.call(second, 'meetings:captureAdopt', session.id, second.holderId),
    /recording this meeting right now/,
  );
  assert.ok(fs.existsSync(captureDirectory(harness.home, session.id)), 'the audio survived every refusal');

  // A call that will not say who it is is refused too: an absent id means "this
  // caller will not say", which cannot be allowed to read as an exemption.
  await assert.rejects(() => harness.call(second, 'meetings:captureDiscard', session.id), /recording this meeting right now/);

  // The recording window's own id matches, so it can finish its own meeting.
  await harness.call(first, 'meetings:captureFinalize', session.id, first.holderId);
  assert.equal(fs.existsSync(captureDirectory(harness.home, session.id)), false);
});

test('the window that is recording may throw its own live capture away', async () => {
  const harness = wire();
  const first = harness.window('wr-first');
  const session = await record(harness, first);
  await harness.call(first, 'meetings:captureAppend', session.id, new Uint8Array([1, 2]), 20_000);

  // The other half of the guard, and the half no test had. `captureFinalize`'s
  // holder id was pinned by the refusals above; `captureDiscard`'s was not, so
  // dropping it from THIS handler left every assertion in this file green while
  // the recording window's own Delete threw the refusal meant for a second
  // window — the one window entitled to press it, told that somebody else was
  // recording the meeting it was recording.
  await harness.call(first, 'meetings:captureDiscard', session.id, first.holderId);

  assert.equal(fs.existsSync(captureDirectory(harness.home, session.id)), false);
  assert.deepEqual(await harness.call(first, 'meetings:captureWriting', { orgId: null }), []);
  assert.deepEqual(await harness.call(first, 'meetings:captureResumable', { orgId: null }), []);
});

test('a window that reloads hands the recording back, and the next window may have it', async () => {
  const harness = wire();
  const first = harness.window('wr-first');
  const second = harness.window('wr-second');
  const session = await record(harness, first);
  await harness.call(first, 'meetings:captureAppend', session.id, new Uint8Array([1, 2]), 20_000);

  // `pagehide` in the reloading renderer — the event main cannot infer, and the
  // one a heartbeat main owned never noticed at all, because a reload leaves
  // main entirely untouched.
  await harness.call(first, 'meetings:captureRelease', first.holderId);

  assert.deepEqual(await harness.call(second, 'meetings:captureWriting', { orgId: null }), []);
  // …and the meeting is an ordinary unfinished recording again: offered back,
  // and deletable, which is what was refused for ever before.
  assert.deepEqual(
    (await harness.call(second, 'meetings:captureResumable', { orgId: null }) as { sessionId: string }[]).map((row) => row.sessionId),
    [session.id],
  );
  await harness.call(second, 'meetings:captureDiscard', session.id, second.holderId);
  assert.equal(fs.existsSync(captureDirectory(harness.home, session.id)), false);
});

test('a window whose renderer died stops being the writer without saying anything', async () => {
  const harness = wire();
  const first = harness.window('wr-first');
  const second = harness.window('wr-second');
  const session = await record(harness, first);

  // A crash gets no `pagehide`, so main watches the caller of the one channel
  // that can create a claim. Without that hook the capture stays claimed by a
  // window that no longer exists for as long as the process lives.
  first.destroy();

  assert.deepEqual(await harness.call(second, 'meetings:captureWriting', { orgId: null }), []);
  await harness.call(second, 'meetings:captureDiscard', session.id, second.holderId);
  assert.equal(fs.existsSync(captureDirectory(harness.home, session.id)), false);
});

test('every change to the live set is announced, so a second window never sits on a stale answer', async () => {
  const harness = wire();
  const first = harness.window('wr-first');
  const session = await record(harness, first);
  assert.deepEqual(harness.published, [MEETING_CAPTURE_WRITERS_CHANNEL], 'Record announced');

  harness.published.length = 0;
  // Reading the set announces nothing: a push per query would be a loop.
  await harness.call(first, 'meetings:captureWriting', { orgId: null });
  await harness.call(first, 'meetings:captureResumable', { orgId: null });
  assert.deepEqual(harness.published, []);

  await harness.call(first, 'meetings:captureStop', session.id);
  assert.deepEqual(harness.published, [MEETING_CAPTURE_WRITERS_CHANNEL], 'Stop announced');

  // A release that released nothing is silent — a reload of a window that was
  // not recording must not make every other window re-query.
  harness.published.length = 0;
  await harness.call(first, 'meetings:captureRelease', 'wr-nobody');
  assert.deepEqual(harness.published, []);

  await harness.call(first, 'meetings:captureFinalize', session.id, first.holderId);
  assert.deepEqual(harness.published, [MEETING_CAPTURE_WRITERS_CHANNEL], 'the close announced');
});

test('a release that really released a recording is announced, and so is a renderer that died', async () => {
  const harness = wire();
  const first = harness.window('wr-first');
  const second = harness.window('wr-second');
  await record(harness, first);
  harness.published.length = 0;

  // The other half of the condition above, and the half that carries the news
  // anybody is waiting for. Announcing only the EMPTY release is the failure
  // inverted: a second window's compose form sits on "another window is
  // recording this meeting" over a window that has gone, for the whole page
  // view, because the writers push is the only thing that re-runs the query.
  await harness.call(first, 'meetings:captureRelease', first.holderId);
  assert.deepEqual(harness.published, [MEETING_CAPTURE_WRITERS_CHANNEL], 'the release was announced');

  // …and the window that cannot report anything, because its renderer died.
  // Same `release`, reached from `watchCaller` instead of `pagehide`, and the
  // staleness it leaves behind is the same staleness.
  await record(harness, second);
  harness.published.length = 0;
  second.destroy();
  assert.deepEqual(harness.published, [MEETING_CAPTURE_WRITERS_CHANNEL], 'the crash was announced');
});

test('the boot pass runs at registration, and cannot correct a capture being recorded into', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-meeting-wire-boot-'));
  const previous = new MeetingCaptureStore(home);
  const interrupted = await previous.begin({ scope: { orgId: null }, title: 'Killed' });
  await previous.writeSegment(interrupted.id, 0, new Uint8Array([1, 2, 3]));
  const reports: string[] = [];

  const store = new MeetingCaptureStore(home);
  const supervisor = new MeetingTranscriptionSupervisor(store, { transcribe: async () => 'text' });
  const handlers = new Map<string, (caller: unknown, ...args: unknown[]) => unknown>();
  registerMeetingCaptureChannels(
    {
      handle: (channel, listener) => { handlers.set(channel, listener); },
      broadcast: () => undefined,
      watchCaller: () => undefined,
    },
    { store, drafts: new MeetingDraftStore(home), supervisor, warn: (message) => { reports.push(message); } },
  );
  // The pass is asynchronous; the offer below is what waits for it.
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  // §6 — the chunk the kill landed on top of was adopted, and the meeting is
  // offered back. That is the deliverable, and it happens at registration,
  // before any window can press Record.
  assert.ok(reports.some((line) => line.includes('adopted a durable chunk')), reports.join(' | '));
  const offers = await handlers.get('meetings:captureResumable')!({ id: 0 }, { orgId: null });
  assert.deepEqual((offers as { sessionId: string }[]).map((row) => row.sessionId), [interrupted.id]);
});

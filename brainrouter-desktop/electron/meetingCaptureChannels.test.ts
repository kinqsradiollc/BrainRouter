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
  // §6 — the chunk the kill landed on top of was adopted, and the meeting is
  // offered back. That is the deliverable, and it happens at registration,
  // before any window can press Record. The offer itself waits on the shared
  // boot gate, so this assertion needs no timing sleep.
  const offers = await handlers.get('meetings:captureResumable')!({ id: 0 }, { orgId: null });
  assert.ok(reports.some((line) => line.includes('adopted a durable chunk')), reports.join(' | '));
  assert.deepEqual((offers as { sessionId: string }[]).map((row) => row.sessionId), [interrupted.id]);
});

test('read, resume and adopt all wait for the same boot reconciliation pass', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-meeting-wire-gate-'));
  const seedStore = new MeetingCaptureStore(home);
  const seed = new MeetingTranscriptionSupervisor(seedStore, { transcribe: async () => 'text' });
  const interrupted = await seed.begin({ scope: { orgId: null }, title: 'Interrupted' });
  await seed.append(interrupted.id, new Uint8Array([1, 2, 3]), 3_000);
  await seed.stop(interrupted.id);
  // This fixture is the previous process, so finish and dispose its background
  // queue before constructing the next process below. Leaving both supervisors
  // live over one record creates a state Electron's single-instance lock rules
  // out, and under a loaded full suite their independent wake timers can race
  // forever instead of testing the boot gate this case is about.
  await seed.settle(interrupted.id);
  seed.dispose();

  const store = new MeetingCaptureStore(home);
  const recover = store.recoverInterrupted.bind(store);
  let releaseRecovery = (): void => undefined;
  const held = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  store.recoverInterrupted = async (options) => {
    await held;
    return await recover(options);
  };
  const supervisor = new MeetingTranscriptionSupervisor(store, { transcribe: async () => 'text' });
  const handlers = new Map<string, (caller: unknown, ...args: unknown[]) => unknown>();
  registerMeetingCaptureChannels(
    {
      handle: (channel, listener) => { handlers.set(channel, listener); },
      broadcast: () => undefined,
      watchCaller: () => undefined,
    },
    { store, drafts: new MeetingDraftStore(home), supervisor, warn: () => undefined },
  );

  let settlements = 0;
  const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => Promise.resolve(
    handlers.get(channel)!({ id: 1 }, ...args),
  ).finally(() => { settlements += 1; });
  const pending = [
    invoke('meetings:captureResumable', { orgId: null }),
    invoke('meetings:captureRead', interrupted.id),
    invoke('meetings:captureAdopt', interrupted.id, 'wr-after-boot'),
  ];
  await Promise.resolve();
  assert.equal(settlements, 0, 'no capture operation can observe a half-reconciled record');

  releaseRecovery();
  const results = await Promise.allSettled(pending);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled', 'fulfilled']);
});

test('a failed boot recovery warns once and releases the capture gate', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-meeting-wire-gate-failure-'));
  const store = new MeetingCaptureStore(home);
  store.recoverInterrupted = async () => { throw new Error('record reconciliation failed'); };
  const supervisor = new MeetingTranscriptionSupervisor(store, { transcribe: async () => 'text' });
  const handlers = new Map<string, (caller: unknown, ...args: unknown[]) => unknown>();
  const warnings: string[] = [];
  registerMeetingCaptureChannels(
    {
      handle: (channel, listener) => { handlers.set(channel, listener); },
      broadcast: () => undefined,
      watchCaller: () => undefined,
    },
    { store, drafts: new MeetingDraftStore(home), supervisor, warn: (message) => { warnings.push(message); } },
  );

  const session = await handlers.get('meetings:captureBegin')!({ id: 1 }, {
    orgId: null,
    title: 'Still usable',
    holderId: 'wr-recovery-failed',
  }) as MeetingCaptureSession;

  assert.equal(session.title, 'Still usable', 'recovery failure does not deadlock later capture calls');
  assert.deepEqual(warnings, ['[meetings] capture recovery failed: record reconciliation failed']);
});

/**
 * D6 — the retention window over the wire.
 *
 * The store's own rules are driven in `meetingCapture.test.ts`; what these ask
 * is whether the WIRE carries them: does the renderer see the window in force,
 * does changing it delete on the spot rather than at the next launch, and does
 * the sweep that runs before an offer refuse a capture this process is writing.
 */
test('D6 — the window is readable, settable, and the setting sweeps immediately', async () => {
  const harness = wire();
  const window = harness.window('wr-only');
  const read = await harness.call(window, 'meetings:retentionRead') as { days: number; choices: number[]; description: string };
  assert.equal(read.days, 30);
  assert.ok(read.choices.includes(7));
  assert.match(read.description, /30 days/);

  // One abandoned capture, older than the window about to be chosen.
  const abandoned = await harness.store.begin({ scope: { orgId: null }, title: 'Abandoned' });
  await harness.store.writeSegment(abandoned.id, 0, new Uint8Array([1, 2, 3]));
  await harness.store.persist({ ...abandoned, startedAt: '2020-01-01T00:00:00.000Z' });

  const written = await harness.call(window, 'meetings:retentionWrite', 7) as { days: number; deleted: number; description: string };
  assert.equal(written.days, 7);
  assert.equal(written.deleted, 1, 'a shortened window deletes now, not at the next launch');
  assert.match(written.description, /7 days/);
  assert.equal(fs.existsSync(captureDirectory(harness.home, abandoned.id)), false);
  // The offer every window is rendering just got shorter, so they are told.
  assert.ok(harness.published.includes(MEETING_CAPTURE_WRITERS_CHANNEL));
  // …and it is what the next read reports, from the store rather than from memory.
  assert.equal((await harness.call(window, 'meetings:retentionRead') as { days: number }).days, 7);
});

test('D6 — a window out of range is clamped on the way in', async () => {
  const harness = wire();
  const window = harness.window('wr-only');
  assert.equal((await harness.call(window, 'meetings:retentionWrite', 99_999) as { days: number }).days, 365);
  assert.equal((await harness.call(window, 'meetings:retentionWrite', -4) as { days: number }).days, 1);
  assert.equal((await harness.call(window, 'meetings:retentionWrite', 'soon') as { days: number }).days, 30);
});

test('D6 — the sweep before an offer cannot delete the capture this window is recording', async () => {
  const harness = wire();
  const window = harness.window('wr-live');
  const live = await record(harness, window);
  await harness.call(window, 'meetings:captureAppend', live.id, new Uint8Array([1, 2, 3]), 3_000);
  // Aged past every window, while the microphone is still open on it.
  const held = await harness.store.stored(live.id);
  await harness.store.persist({ ...held.session, startedAt: '2020-01-01T00:00:00.000Z' });
  await harness.call(window, 'meetings:retentionWrite', 1);

  assert.ok(fs.existsSync(captureDirectory(harness.home, live.id)), 'liveness comes from the process, and the process is writing');
  // The offer, which sweeps before it answers, leaves it alone too — and does
  // not offer a recording in progress back to anyone.
  const offers = await harness.call(window, 'meetings:captureResumable', { orgId: null }) as { sessionId: string }[];
  assert.deepEqual(offers.map((offer) => offer.sessionId), []);
  assert.ok(fs.existsSync(captureDirectory(harness.home, live.id)));

  // Once that window is gone, the same capture is exactly what the sweep is for.
  window.destroy();
  await harness.call(harness.window('wr-next'), 'meetings:captureResumable', { orgId: null });
  assert.equal(fs.existsSync(captureDirectory(harness.home, live.id)), false);
});

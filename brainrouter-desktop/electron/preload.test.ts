/**
 * ADR-035 D6 — the preload wire, INVOKED rather than read.
 *
 * ## What it owns
 *
 * One question about `preload.cts`: does an argument reach `ipcRenderer.invoke`.
 * Nothing about what main then does with it — that is
 * `meetingCaptureChannels.test.ts` — and nothing about the rest of the bridge,
 * which is out of this ADR's way.
 *
 * ## Why it exists, specifically
 *
 * All four `holderId` threads through this file could be cut with the whole
 * repository green — measured: the typecheck, the electron suite and the
 * renderer suite all passed with every one of them removed. The only test that
 * touched the preload read it as SOURCE TEXT and grepped that
 * `ipcRenderer.invoke('meetings:captureX'` appears somewhere in it, which cannot
 * see whether an argument is passed, let alone whether it is remembered.
 *
 * And one of those threads is the reload fix itself. Cut only the line in
 * `captureBegin` that remembers the id, and `meetingCaptureHolderId` stays null,
 * so the `pagehide` handler returns early and a window RELOAD strands the
 * recording permanently — claimed in main by a page that no longer exists,
 * hidden from every offer, refused to every other window. That is the precise
 * defect this preload's `pagehide` exists to fix, and it was deletable in
 * silence.
 *
 * ## How it drives a preload script
 *
 * `preload.cjs` is CommonJS and reaches for two things Node does not have:
 * `require('electron')` and a DOM `window`. Both are supplied — the module
 * loader is patched for the length of one load, and a `window` with an
 * `addEventListener` that keeps the `pagehide` listener where a test can fire
 * it. The script is loaded fresh each time (its module cache entry is dropped
 * first), because the id it remembers is per-page state and a shared one would
 * make a result depend on test order.
 */
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import test from 'node:test';

const load = createRequire(import.meta.url);
const PRELOAD = load.resolve('./preload.cjs');

/** One `ipcRenderer.invoke`, as the main process would have received it. */
interface Invocation {
  readonly channel: string;
  readonly args: readonly unknown[];
}

/** The capture half of what the preload exposed, typed as its callers call it. */
interface MeetingsSurface {
  captureBegin(input: { title?: string; holderId?: string }): Promise<unknown>;
  captureAppend(id: string, bytes: Uint8Array, durationMs: number): Promise<unknown>;
  captureStop(id: string): Promise<unknown>;
  captureAdopt(id: string, holderId?: string): Promise<unknown>;
  captureFinalize(id: string, holderId?: string): Promise<unknown>;
  captureDiscard(id: string, holderId?: string): Promise<unknown>;
}

interface LoadedPreload {
  readonly meetings: MeetingsSurface;
  /** Every invoke this page made, in order. */
  readonly invocations: Invocation[];
  /** The page going away — a reload, a navigation, an ordinary close. */
  pagehide(): void;
}

type LoadHook = (request: string, parent: unknown, isMain: boolean) => unknown;

function loadPreload(): LoadedPreload {
  const invocations: Invocation[] = [];
  const pagehideListeners: Array<() => void> = [];
  // Held on an object rather than in a `let`, so reading it after the load is a
  // property access the compiler does not have to narrow across a callback.
  const exposed: { api: unknown } = { api: null };

  const electron = {
    contextBridge: { exposeInMainWorld: (_key: string, api: unknown) => { exposed.api = api; } },
    ipcRenderer: {
      invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
        invocations.push({ channel, args });
        return { ok: true };
      },
      send: (): void => undefined,
      // The preload reads two bits of boot state synchronously and tolerates a
      // main process that has neither, which is what this answers.
      sendSync: (): unknown => null,
      on: (): void => undefined,
      removeListener: (): void => undefined,
    },
    webFrame: { getZoomFactor: (): number => 1, setZoomFactor: (): void => undefined },
  };

  const internals = Module as unknown as { _load: LoadHook };
  const original = internals._load;
  const scope = globalThis as unknown as { window?: unknown };
  const hadWindow = 'window' in scope;
  const previousWindow = scope.window;
  scope.window = {
    addEventListener: (event: string, listener: () => void): void => {
      if (event === 'pagehide') pagehideListeners.push(listener);
    },
  };
  internals._load = function patched(this: unknown, request, parent, isMain) {
    return request === 'electron' ? electron : original.call(this, request, parent, isMain);
  };
  try {
    // A fresh page every time: the holder id below is per-window state, and a
    // cached module would carry one test's recording into the next one.
    delete load.cache[PRELOAD];
    load(PRELOAD);
  } finally {
    internals._load = original;
    if (hadWindow) scope.window = previousWindow;
    else delete scope.window;
  }

  const meetings = (exposed.api as { meetings?: MeetingsSurface } | null)?.meetings;
  if (!meetings) throw new Error('the preload exposed no meetings surface');
  return {
    meetings,
    invocations,
    pagehide: () => { for (const listener of [...pagehideListeners]) listener(); },
  };
}

test('the holder id Record sends is the one this page hands back when it goes away', async () => {
  const preload = loadPreload();

  await preload.meetings.captureBegin({ title: 'Weekly sync', holderId: 'wr-window-a' });

  // It reaches main at all — the thread that, cut, means no capture is ever
  // claimed and every "is somebody recording?" answers no.
  assert.deepEqual(preload.invocations, [
    { channel: 'meetings:captureBegin', args: [{ title: 'Weekly sync', holderId: 'wr-window-a' }] },
  ]);

  // …and it was REMEMBERED. This is the reload fix: main is untouched by a
  // renderer reload, so the page is the only thing that can report it, and it
  // can only report an id it kept. Without the memory this handler returns early
  // and the recording stays claimed by a page that no longer exists.
  preload.pagehide();
  assert.deepEqual(preload.invocations[1], { channel: 'meetings:captureRelease', args: ['wr-window-a'] });
});

test('a page that claimed nothing releases nothing', async () => {
  const preload = loadPreload();

  // No Record at all: a reload of a window that was only reading meetings must
  // not make every other window re-query. Asserted over a mapped copy rather
  // than the array itself, because `assert/strict`'s `deepEqual` narrows its
  // first argument and would leave the list below typed `never[]`.
  preload.pagehide();
  assert.deepEqual(preload.invocations.map((invocation) => invocation.channel), []);

  // Nor does a Record that would not say who it was. An absent id is "this
  // caller will not say", and releasing on its behalf would be releasing a
  // recording named by nobody.
  await preload.meetings.captureBegin({ title: 'Anonymous' });
  preload.pagehide();
  assert.deepEqual(preload.invocations.map((invocation) => invocation.channel), ['meetings:captureBegin']);
});

test('every channel that takes or releases a recording carries this window past the boundary', async () => {
  const preload = loadPreload();

  await preload.meetings.captureAdopt('mtg-20260809-aaaaaaaa', 'wr-window-a');
  await preload.meetings.captureFinalize('mtg-20260809-bbbbbbbb', 'wr-window-a');
  await preload.meetings.captureDiscard('mtg-20260809-cccccccc', 'wr-window-a');

  // Drop the second argument from any of these three and main can no longer
  // tell the window that is recording a meeting from a second one looking at a
  // stale offer: it would have to refuse for either or neither. `captureDiscard`
  // is the one that was unpinned everywhere — dropping it makes the RECORDING
  // window's own Delete throw "Another window is recording this meeting right
  // now" at the only window entitled to press it.
  assert.deepEqual(preload.invocations, [
    { channel: 'meetings:captureAdopt', args: ['mtg-20260809-aaaaaaaa', 'wr-window-a'] },
    { channel: 'meetings:captureFinalize', args: ['mtg-20260809-bbbbbbbb', 'wr-window-a'] },
    { channel: 'meetings:captureDiscard', args: ['mtg-20260809-cccccccc', 'wr-window-a'] },
  ]);
});

test('the audio path carries the bytes and the time they took', async () => {
  const preload = loadPreload();

  await preload.meetings.captureAppend('mtg-20260809-aaaaaaaa', new Uint8Array([1, 2, 3]), 20_000);
  await preload.meetings.captureStop('mtg-20260809-aaaaaaaa');

  // D1/D5 — the chunk is the meeting, and the duration beside it is what a
  // stated gap prints as its time range. Either one dropped here is a defect no
  // type and no source-text grep can see.
  assert.deepEqual(preload.invocations, [
    { channel: 'meetings:captureAppend', args: ['mtg-20260809-aaaaaaaa', new Uint8Array([1, 2, 3]), 20_000] },
    { channel: 'meetings:captureStop', args: ['mtg-20260809-aaaaaaaa'] },
  ]);
});

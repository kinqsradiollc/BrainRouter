/**
 * ADR-035 D6 — the migration out of `localStorage`, tested on the cases that
 * used to survive it.
 *
 * Three holes closed here, and each of them is a value that stayed in a store
 * any page script can read: a record whose shape today's parser rejects, a
 * hand-over deferred to a debounce that was cancelled before it ran, and a write
 * into a preload that has no draft channel — which resolved, told nobody, and
 * left the words nowhere at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { MeetingCaptureOps, MeetingComposeDraft } from './captureOps.js';
import { LEGACY_DRAFT_KEY, migrateLegacyDraft, takeLegacyDraft } from './legacyDraft.js';

/** Only what the migration touches; a `Storage` this is not, and does not need to be. */
function storage(value: string | null): { getItem(key: string): string | null; removeItem(key: string): void; readonly held: () => string | null } {
  let held = value;
  return {
    getItem: (key) => (key === LEGACY_DRAFT_KEY ? held : null),
    removeItem: (key) => { if (key === LEGACY_DRAFT_KEY) held = null; },
    held: () => held,
  };
}

interface Recorded {
  readonly writes: MeetingComposeDraft[];
  readonly ops: MeetingCaptureOps;
}

function fakeCapture(options: { draftAvailable?: boolean; stored?: MeetingComposeDraft | null; write?: () => Promise<void> } = {}): Recorded {
  const writes: MeetingComposeDraft[] = [];
  return {
    writes,
    ops: {
      available: true,
      begin: async () => { throw new Error('not used'); },
      append: async () => { throw new Error('not used'); },
      stop: async () => { throw new Error('not used'); },
      read: async () => { throw new Error('not used'); },
      adopt: async () => { throw new Error('not used'); },
      retrySegment: async () => { throw new Error('not used'); },
      onProgress: () => () => undefined,
      finalize: async () => undefined,
      discard: async () => undefined,
      resumable: async () => [],
      draftAvailable: options.draftAvailable ?? true,
      readDraft: async () => options.stored ?? null,
      writeDraft: async (draft) => { writes.push(draft); if (options.write) await options.write(); },
      clearDraft: async () => undefined,
    } as MeetingCaptureOps,
  };
}

test('the legacy key is emptied whatever it holds, not only when it parses', async () => {
  // Four shapes an older build could have left. Only the last is one today's
  // parser understands, and gating the delete on that parse is what kept the
  // other three — with the meeting's own words in them, because D4 folded live
  // transcript into this draft every 250 ms.
  for (const raw of ['{"transcript":', 'null', '{"title":42,"transcript":{"text":"Ship on Friday."}}', '{"title":"Sync","transcript":"Ship on Friday."}']) {
    const store = storage(raw);
    takeLegacyDraft(store);
    assert.equal(store.held(), null, `left behind: ${raw}`);
  }
});

test('a draft that parses is handed to the protected store and then exists in one place', async () => {
  const store = storage(JSON.stringify({ title: 'Weekly sync', transcript: 'Ship on Friday.', template: 'standup', language: 'en' }));
  const capture = fakeCapture();

  const pending = await migrateLegacyDraft(capture.ops, store);

  assert.deepEqual(capture.writes, [{ title: 'Weekly sync', transcript: 'Ship on Friday.', template: 'standup', language: 'en' }]);
  // Nothing is returned, because the words are somewhere durable now — and the
  // hand-over happened inside this call rather than being left to a debounce
  // whose cleanup cancelled it.
  assert.equal(pending, null);
  assert.equal(store.held(), null);
});

test('a preload with no draft channel gets the words back rather than losing them', async () => {
  const store = storage(JSON.stringify({ title: 'Weekly sync', transcript: 'Ship on Friday.' }));
  const capture = fakeCapture({ draftAvailable: false });

  const pending = await migrateLegacyDraft(capture.ops, store);

  // `writeDraft` would have resolved and done nothing, which is indistinguishable
  // from success here and is how the only copy of a draft disappeared.
  assert.deepEqual(capture.writes, []);
  assert.deepEqual(pending, { title: 'Weekly sync', transcript: 'Ship on Friday.' });
  // Still removed: D6's objection is to the words being in that store at all.
  assert.equal(store.held(), null);
});

test('a write that fails hands the words back to the form instead of destroying them', async () => {
  const store = storage(JSON.stringify({ title: 'Weekly sync', transcript: 'Ship on Friday.' }));
  const capture = fakeCapture({ write: async () => { throw new Error('the draft file could not be written'); } });

  const pending = await migrateLegacyDraft(capture.ops, store);

  assert.deepEqual(pending, { title: 'Weekly sync', transcript: 'Ship on Friday.' });
  assert.equal(store.held(), null);
});

test('a draft already in the protected file is never overwritten by the older copy', async () => {
  const store = storage(JSON.stringify({ title: 'Older', transcript: 'From the previous build.' }));
  const capture = fakeCapture({ stored: { title: 'Newer', transcript: 'Typed since the upgrade.' } });

  const pending = await migrateLegacyDraft(capture.ops, store);

  // The protected file can only have been written since the upgrade, so it is
  // the newer of the two; restoring the legacy copy over it would put an older
  // draft back into the form the user is typing in.
  assert.deepEqual(capture.writes, []);
  assert.equal(pending, null);
  assert.equal(store.held(), null);
});

test('an empty or absent key is not a draft and asks nothing of the host', async () => {
  const capture = fakeCapture();
  assert.equal(await migrateLegacyDraft(capture.ops, storage(null)), null);
  assert.equal(await migrateLegacyDraft(capture.ops, storage(JSON.stringify({ title: '', transcript: '' }))), null);
  assert.deepEqual(capture.writes, []);
});

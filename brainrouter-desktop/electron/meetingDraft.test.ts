/**
 * ADR-035 D6 — the draft's protected location, checked rather than asserted in
 * a comment.
 *
 * Two properties, and both are the reason the draft moved off `localStorage`:
 * it lands inside the `0700` capture directory as a `0600` file, and it is
 * invisible to every pass that walks that directory looking for captures — a
 * draft file mistaken for a capture would be reaped, or worse, offered back as a
 * recording with no audio in it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MeetingCaptureStore, MEETING_CAPTURE_DIRECTORY } from './meetingCapture.js';
import { MeetingDraftStore } from './meetingDraft.js';

const POSIX = process.platform !== 'win32';

function userData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-meeting-draft-'));
}

test('the draft is written 0600 inside the 0700 capture directory', async () => {
  const home = userData();
  const drafts = new MeetingDraftStore(home);

  await drafts.write({ title: 'Weekly sync', transcript: 'Pasted notes.', template: 'standup', language: 'en' });

  const root = path.join(home, MEETING_CAPTURE_DIRECTORY);
  const file = path.join(root, 'compose-draft.json');
  assert.ok(fs.statSync(file).isFile());
  if (POSIX) {
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(await drafts.read(), { title: 'Weekly sync', transcript: 'Pasted notes.', template: 'standup', language: 'en' });
});

test('an emptied form deletes the draft, and a record from another version is refused', async () => {
  const home = userData();
  const drafts = new MeetingDraftStore(home);
  const file = path.join(home, MEETING_CAPTURE_DIRECTORY, 'compose-draft.json');

  await drafts.write({ title: 'Weekly sync', transcript: 'Pasted notes.' });
  assert.ok(fs.existsSync(file));
  // Writing an empty draft IS clearing it: a form the user emptied should not
  // come back with what they deleted.
  await drafts.write({ title: '', transcript: '' });
  // Asserted on the FILE, not only through `read`. D6 is "deletion is a real
  // deletion", and `read` narrows an empty record to `null` all by itself — so
  // a test that only checks `read` cannot tell a draft that was deleted from
  // one that was blanked and left on disk, which is the meeting's own words
  // still sitting in the protected directory with nothing left that will ever
  // remove them.
  assert.equal(fs.existsSync(file), false);
  assert.equal(await drafts.read(), null);

  await drafts.write({ title: 'Weekly sync', transcript: 'Pasted notes.' });
  await drafts.clear();
  assert.equal(fs.existsSync(file), false);
  assert.equal(await drafts.read(), null);
  // Clearing what is not there is not an error — the meeting was created either
  // way, and this runs after it.
  await drafts.clear();

  fs.writeFileSync(file, '{"version":1,"draft":{"title":7,"template":"invented"}}');
  assert.equal(await drafts.read(), null);
  fs.writeFileSync(file, 'not json at all');
  assert.equal(await drafts.read(), null);
});

test('the draft is invisible to the capture passes that share its directory', async () => {
  const home = userData();
  const store = new MeetingCaptureStore(home);
  const drafts = new MeetingDraftStore(home);

  const session = await store.begin({ scope: { orgId: 'org_1' }, title: 'Weekly sync' });
  await store.writeSegment(session.id, 0, new Uint8Array([1, 2, 3]));
  await drafts.write({ title: 'Weekly sync', transcript: 'Pasted notes.' });

  // The boot pass walks this root for capture directories. A draft file must be
  // neither an orphan to reap nor a capture to recover — and it must still be
  // there afterwards.
  const report = await store.recoverInterrupted();
  assert.deepEqual(report.reaped, []);
  assert.deepEqual(await drafts.read(), { title: 'Weekly sync', transcript: 'Pasted notes.' });
  assert.deepEqual((await store.resumable({ orgId: 'org_1' })).map((row) => row.sessionId), [session.id]);
});

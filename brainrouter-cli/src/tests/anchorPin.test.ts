import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANCHOR_MARKER,
  MID_SESSION_REFRESH_HEADING,
  decideAnchorAction,
  hashBriefingContent,
  isPinningEnabled,
  wrapAnchorContent,
  wrapMidSessionRefresh,
} from '../memory/anchorPin.js';

test('isPinningEnabled defaults to true when env var is unset', () => {
  assert.equal(isPinningEnabled(undefined), true);
});

test('isPinningEnabled recognises off / 0 / false as disabled', () => {
  for (const v of ['off', 'OFF', '0', 'false', 'False', ' off ']) {
    assert.equal(isPinningEnabled(v), false, `expected ${JSON.stringify(v)} to disable`);
  }
});

test('isPinningEnabled treats other strings (including "on", "1") as enabled', () => {
  for (const v of ['on', '1', 'true', 'yes', '']) {
    assert.equal(isPinningEnabled(v), true, `expected ${JSON.stringify(v)} to enable`);
  }
});

test('hashBriefingContent is stable for the same input', () => {
  const a = hashBriefingContent('alpha\nbeta');
  const b = hashBriefingContent('alpha\nbeta');
  assert.equal(a, b);
  assert.equal(a.length, 16);
});

test('hashBriefingContent differs between distinct inputs', () => {
  assert.notEqual(hashBriefingContent('alpha'), hashBriefingContent('beta'));
});

test('decideAnchorAction returns LEGACY when env is off', () => {
  const decision = decideAnchorAction({
    newContentHash: 'a'.repeat(16),
    pinnedHash: null,
    envSetting: 'off',
  });
  assert.equal(decision.action, 'LEGACY');
  assert.equal(decision.nextPinnedHash, null);
});

test('decideAnchorAction returns PIN on the first briefing when enabled', () => {
  const decision = decideAnchorAction({
    newContentHash: 'a'.repeat(16),
    pinnedHash: null,
    envSetting: undefined,
  });
  assert.equal(decision.action, 'PIN');
  assert.equal(decision.nextPinnedHash, 'a'.repeat(16));
});

test('decideAnchorAction returns STABLE when content hash matches the pin', () => {
  const decision = decideAnchorAction({
    newContentHash: 'a'.repeat(16),
    pinnedHash: 'a'.repeat(16),
    envSetting: 'on',
  });
  assert.equal(decision.action, 'STABLE');
  assert.equal(decision.nextPinnedHash, 'a'.repeat(16));
});

test('decideAnchorAction returns APPEND when content differs from the pin', () => {
  const decision = decideAnchorAction({
    newContentHash: 'b'.repeat(16),
    pinnedHash: 'a'.repeat(16),
    envSetting: 'on',
  });
  assert.equal(decision.action, 'APPEND');
  // The pin does NOT change in APPEND — only /refresh-memory rotates it.
  assert.equal(decision.nextPinnedHash, 'a'.repeat(16));
});

test('wrapAnchorContent prepends the anchor marker', () => {
  const wrapped = wrapAnchorContent('## Briefing\nfoo');
  assert.ok(wrapped.startsWith(ANCHOR_MARKER));
  assert.ok(wrapped.endsWith('## Briefing\nfoo'));
});

test('wrapMidSessionRefresh prepends the refresh heading', () => {
  const wrapped = wrapMidSessionRefresh('## Briefing\nfoo');
  assert.ok(wrapped.startsWith(MID_SESSION_REFRESH_HEADING));
  assert.ok(wrapped.includes('## Briefing\nfoo'));
});

test('PIN → STABLE → APPEND round-trip mirrors a real session', () => {
  let pinned: string | null = null;
  const blockA = 'recall: rec_001\nrec_002';
  const blockB = 'recall: rec_001\nrec_002';
  const blockC = 'recall: rec_999';

  let d = decideAnchorAction({
    newContentHash: hashBriefingContent(blockA),
    pinnedHash: pinned,
    envSetting: 'on',
  });
  assert.equal(d.action, 'PIN');
  pinned = d.nextPinnedHash;

  d = decideAnchorAction({
    newContentHash: hashBriefingContent(blockB),
    pinnedHash: pinned,
    envSetting: 'on',
  });
  assert.equal(d.action, 'STABLE');

  d = decideAnchorAction({
    newContentHash: hashBriefingContent(blockC),
    pinnedHash: pinned,
    envSetting: 'on',
  });
  assert.equal(d.action, 'APPEND');
  // Pin is unchanged after APPEND.
  assert.equal(d.nextPinnedHash, pinned);
});

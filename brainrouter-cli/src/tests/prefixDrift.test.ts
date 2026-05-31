import test from 'node:test';
import assert from 'node:assert/strict';

import { snapshotPrefix, diffPrefixSnapshots, shortHash } from '../runtime/prefixDrift.js';
import { ImmutablePrefix } from '../runtime/contextRegions.js';

const tool = (name: string) => ({ type: 'function' as const, function: { name, description: '', parameters: {} } });

// --- pure diff -------------------------------------------------------------

test('shortHash is stable + content-sensitive', () => {
  assert.equal(shortHash('abc'), shortHash('abc'));
  assert.notEqual(shortHash('abc'), shortHash('abd'));
});

test('diff reports no change for identical snapshots', () => {
  const s = snapshotPrefix({ system: 'sys', toolNames: ['a', 'b'], anchors: ['x'] });
  const d = diffPrefixSnapshots(s, s);
  assert.equal(d.changed, false);
  assert.equal(d.label, 'no change');
});

test('diff labels tool add/remove', () => {
  const a = snapshotPrefix({ system: 'sys', toolNames: ['a', 'b'], anchors: [] });
  const b = snapshotPrefix({ system: 'sys', toolNames: ['a', 'c', 'd'], anchors: [] });
  const d = diffPrefixSnapshots(a, b);
  assert.deepEqual(d.addedTools, ['c', 'd']);
  assert.deepEqual(d.removedTools, ['b']);
  assert.equal(d.systemChanged, false);
  assert.match(d.label, /\+2\/-1 tools/);
});

test('diff labels system + anchor changes with delta', () => {
  const a = snapshotPrefix({ system: 'old', toolNames: [], anchors: ['x'] });
  const b = snapshotPrefix({ system: 'new', toolNames: [], anchors: ['x', 'y', 'z'] });
  const d = diffPrefixSnapshots(a, b);
  assert.equal(d.systemChanged, true);
  assert.equal(d.anchorsChanged, true);
  assert.equal(d.anchorDelta, 2);
  assert.match(d.label, /system changed/);
  assert.match(d.label, /anchors \+2/);
});

// --- ImmutablePrefix integration ------------------------------------------

test('ImmutablePrefix records the last drift cause + snapshot diffs', () => {
  const p = new ImmutablePrefix({ system: 'sys', toolSpecs: [tool('a')], anchors: [] });
  assert.equal(p.lastDriftCause, null, 'no cause before any mutation');

  const before = p.snapshot();
  assert.equal(p.addTool(tool('b')), true);
  assert.equal(p.lastDriftCause, 'tools');

  const after = p.snapshot();
  const d = diffPrefixSnapshots(before, after);
  assert.deepEqual(d.addedTools, ['b']);

  assert.equal(p.setAnchors([{ role: 'assistant', content: 'anchor' }]), true);
  assert.equal(p.lastDriftCause, 'anchors');

  assert.equal(p.replaceSystem('new-sys'), true);
  assert.equal(p.lastDriftCause, 'system');

  // A no-op setter does not change the recorded cause.
  assert.equal(p.replaceSystem('new-sys'), false);
  assert.equal(p.lastDriftCause, 'system');
});

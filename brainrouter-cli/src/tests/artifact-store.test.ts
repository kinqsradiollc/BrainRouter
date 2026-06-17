import test from 'node:test';
import assert from 'node:assert/strict';
import { isArtifactRecord } from '@kinqs/brainrouter-types';
import {
  createArtifact,
  getArtifact,
  updateArtifact,
  listArtifacts,
  linkArtifact,
  deleteArtifact,
  readArtifactsAll,
} from '../state/artifactStore.js';
import { withTempWorkspace } from './_helpers.js';

test('artifactStore: create → read back; id generated; defaults + timestamps', () => {
  withTempWorkspace((workspace) => {
    const a = createArtifact(workspace, { kind: 'markdown-report', title: 'Recall report', sessionKey: 'sess:a' });
    assert.match(a.id, /^art_[0-9a-f]{8}$/);
    assert.equal(a.kind, 'markdown-report');
    assert.equal(a.title, 'Recall report');
    assert.equal(a.status, 'draft'); // default
    assert.equal(a.format, 'markdown'); // default
    assert.equal(a.workspaceRoot, workspace);
    assert.equal(a.sessionKey, 'sess:a');
    assert.deepEqual(a.linkedMemoryIds, []);
    assert.equal(a.createdAt, a.updatedAt);
    assert.deepEqual(getArtifact(workspace, a.id), a);
  });
});

test('artifactStore: empty title is rejected', () => {
  withTempWorkspace((workspace) => {
    assert.throws(() => createArtifact(workspace, { kind: 'other', title: '   ' }));
  });
});

test('artifactStore: optional fields only set when present (clean JSON round-trip)', () => {
  withTempWorkspace((workspace) => {
    const a = createArtifact(workspace, { kind: 'html-prototype', title: 'Proto', format: 'html', path: 'out/proto.html', summary: 'a demo', requirementId: 'req_1' });
    assert.equal(a.path, 'out/proto.html');
    assert.equal(a.summary, 'a demo');
    assert.equal(a.requirementId, 'req_1');
    assert.equal(a.format, 'html');
    assert.equal('content' in a, false); // not supplied → absent
    assert.deepEqual(readArtifactsAll(workspace)[a.id], a);
  });
});

test('artifactStore: update status/summary bumps updatedAt and freezes id/createdAt', () => {
  withTempWorkspace((workspace) => {
    const a = createArtifact(workspace, { kind: 'design-note', title: 'Schema' });
    const tick = Date.now();
    while (Date.now() === tick) { /* spin ~1ms so updatedAt is strictly newer */ }
    const up = updateArtifact(workspace, a.id, { status: 'final', summary: 'agreed' });
    assert.ok(up);
    assert.equal(up.status, 'final');
    assert.equal(up.summary, 'agreed');
    assert.equal(up.createdAt, a.createdAt); // frozen
    assert.ok(up.updatedAt > a.updatedAt); // bumped
    assert.deepEqual(getArtifact(workspace, a.id), up);
  });
});

test('artifactStore: update returns undefined for a missing id', () => {
  withTempWorkspace((workspace) => {
    assert.equal(updateArtifact(workspace, 'art_deadbeef', { status: 'final' }), undefined);
  });
});

test('artifactStore: list filters by kind/status/requirement, newest first', () => {
  withTempWorkspace((workspace) => {
    const a = createArtifact(workspace, { kind: 'design-note', title: 'A', requirementId: 'req_x' });
    const b = createArtifact(workspace, { kind: 'review-export', title: 'B' });
    updateArtifact(workspace, b.id, { status: 'final' });
    assert.deepEqual(listArtifacts(workspace, { kind: 'design-note' }).map((x) => x.id), [a.id]);
    assert.deepEqual(listArtifacts(workspace, { status: 'final' }).map((x) => x.id), [b.id]);
    assert.deepEqual(listArtifacts(workspace, { requirementId: 'req_x' }).map((x) => x.id), [a.id]);
    assert.equal(listArtifacts(workspace).length, 2);
  });
});

test('artifactStore: workspaces are isolated', () => {
  withTempWorkspace((wsA) => {
    withTempWorkspace((wsB) => {
      const a = createArtifact(wsA, { kind: 'other', title: 'only-A' });
      assert.equal(listArtifacts(wsB).length, 0);
      assert.ok(getArtifact(wsA, a.id));
      assert.equal(getArtifact(wsB, a.id), undefined);
    });
  });
});

test('artifactStore: linkArtifact pushes unique memory ids', () => {
  withTempWorkspace((workspace) => {
    const a = createArtifact(workspace, { kind: 'verification-summary', title: 'V' });
    linkArtifact(workspace, a.id, { memoryId: 'mem_1' });
    linkArtifact(workspace, a.id, { memoryId: 'mem_1' }); // dupe ignored
    linkArtifact(workspace, a.id, { memoryId: 'mem_2' });
    assert.deepEqual(getArtifact(workspace, a.id)!.linkedMemoryIds, ['mem_1', 'mem_2']);
    assert.equal(linkArtifact(workspace, 'art_missing', { memoryId: 'm' }), undefined);
  });
});

test('artifactStore: state persists across a fresh read (simulated restart)', () => {
  withTempWorkspace((workspace) => {
    const a = createArtifact(workspace, { kind: 'sketch', title: 'Persisted' });
    assert.deepEqual(readArtifactsAll(workspace)[a.id], getArtifact(workspace, a.id));
    assert.ok(deleteArtifact(workspace, a.id));
    assert.equal(getArtifact(workspace, a.id), undefined);
    assert.equal(deleteArtifact(workspace, a.id), false); // already gone
  });
});

test('isArtifactRecord: accepts a real record and rejects malformed shapes', () => {
  withTempWorkspace((workspace) => {
    const a = createArtifact(workspace, { kind: 'markdown-report', title: 'Good' });
    assert.equal(isArtifactRecord(a), true);
    assert.equal(isArtifactRecord({ ...a, kind: 'bogus' }), false);
    assert.equal(isArtifactRecord({ ...a, status: 'nope' }), false);
    assert.equal(isArtifactRecord({ id: 'x' }), false);
    assert.equal(isArtifactRecord(null), false);
  });
});

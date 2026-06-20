import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isArtifactRecord, ARTIFACT_SCHEMA_VERSION } from '@kinqs/brainrouter-types';
import {
  createArtifact,
  getArtifact,
  updateArtifact,
  listArtifacts,
  linkArtifact,
  deleteArtifact,
  readArtifactsAll,
  listArtifactVersions,
  getArtifactVersion,
  revertArtifact,
} from '../artifact/artifactStore.js';
import { getStateFile } from '../storage/store.js';
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

// --- §AV-1 versioning ---------------------------------------------------

test('artifactStore: a new artifact starts at v1 with a snapshot + schemaVersion', () => {
  withTempWorkspace((workspace) => {
    const a = createArtifact(workspace, { kind: 'markdown-report', title: 'V', content: '# hi', editedBy: 'user' });
    assert.equal(a.schemaVersion, ARTIFACT_SCHEMA_VERSION);
    assert.equal(a.currentVersion, 1);
    assert.equal(a.versions?.length, 1);
    const v1 = a.versions![0];
    assert.equal(v1.v, 1);
    assert.equal(v1.content, '# hi');
    assert.equal(v1.format, 'markdown');
    assert.equal(v1.editedBy, 'user');
    assert.match(v1.contentHash, /^[0-9a-f]{8}$/);
  });
});

test('artifactStore: editing CONTENT appends a version; metadata-only does NOT', () => {
  withTempWorkspace((workspace) => {
    const a = createArtifact(workspace, { kind: 'markdown-report', title: 'Doc', content: 'v1 body' });
    // metadata-only edit → still 1 version
    const meta = updateArtifact(workspace, a.id, { status: 'final', summary: 'done' });
    assert.equal(meta!.versions!.length, 1);
    assert.equal(meta!.currentVersion, 1);
    // content edit → v2
    const edited = updateArtifact(workspace, a.id, { content: 'v2 body' }, { editedBy: 'user', note: 'expand' });
    assert.equal(edited!.versions!.length, 2);
    assert.equal(edited!.currentVersion, 2);
    assert.equal(edited!.content, 'v2 body');
    assert.equal(edited!.versions![1].note, 'expand');
    assert.equal(edited!.versions![1].editedBy, 'user');
    // identical content → no new version
    const noop = updateArtifact(workspace, a.id, { content: 'v2 body' });
    assert.equal(noop!.versions!.length, 2);
  });
});

test('artifactStore: revert restores prior content as a NEW version (append-only)', () => {
  withTempWorkspace((workspace) => {
    const a = createArtifact(workspace, { kind: 'html-prototype', title: 'P', format: 'html', content: '<h1>a</h1>' });
    updateArtifact(workspace, a.id, { content: '<h1>b</h1>' }); // v2
    const reverted = revertArtifact(workspace, a.id, 1, { editedBy: 'user' });
    assert.equal(reverted!.content, '<h1>a</h1>');
    assert.equal(reverted!.versions!.length, 3); // v1, v2, v3(=copy of v1)
    assert.equal(reverted!.currentVersion, 3);
    assert.equal(reverted!.versions![2].note, 'revert to v1');
    // version listing + lookup
    assert.deepEqual(listArtifactVersions(workspace, a.id).map((v) => v.v), [1, 2, 3]);
    assert.equal(getArtifactVersion(workspace, a.id, 2)!.content, '<h1>b</h1>');
    assert.equal(getArtifactVersion(workspace, a.id, 99), undefined);
    assert.equal(revertArtifact(workspace, a.id, 99), undefined); // unknown version
  });
});

test('artifactStore: legacy pre-versioning records are migrated to v1 on read', () => {
  withTempWorkspace((workspace) => {
    // Hand-write a legacy record (no versions/currentVersion/schemaVersion).
    const legacy = {
      art_legacy00: {
        id: 'art_legacy00', kind: 'design-note', title: 'Old', status: 'draft', format: 'markdown',
        content: 'legacy content', workspaceRoot: workspace, linkedMemoryIds: [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
      },
    };
    fs.writeFileSync(getStateFile(workspace, 'artifacts.json'), JSON.stringify(legacy), 'utf8');
    const a = getArtifact(workspace, 'art_legacy00');
    assert.ok(a);
    assert.equal(a!.currentVersion, 1);
    assert.equal(a!.versions!.length, 1);
    assert.equal(a!.versions![0].content, 'legacy content');
    assert.equal(a!.versions![0].editedAt, '2026-01-02T00:00:00.000Z'); // from updatedAt
    // migration is in-memory only until a mutation — disk still legacy
    assert.equal(readArtifactsAll(workspace).art_legacy00.versions, undefined);
    // a content edit persists the migrated form + appends v2
    const edited = updateArtifact(workspace, 'art_legacy00', { content: 'new' });
    assert.equal(edited!.versions!.length, 2);
    assert.equal(readArtifactsAll(workspace).art_legacy00.versions!.length, 2);
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

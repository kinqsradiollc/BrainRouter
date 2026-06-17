import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isAnnotationRecord } from '@kinqs/brainrouter-types';
import { getCliStateFile } from '../state/cliState.js';
import {
  createAnnotation,
  getAnnotation,
  updateAnnotation,
  setStatus,
  listAnnotations,
  linkAnnotation,
  deleteAnnotation,
  readAnnotationsAll,
} from '../state/annotationStore.js';
import { withTempWorkspace } from './_helpers.js';

test('annotationStore: create → read back; id generated; defaults + timestamps set', () => {
  withTempWorkspace((workspace) => {
    const rec = createAnnotation(workspace, {
      type: 'requirement',
      targetId: 'req_1234abcd',
      body: 'Tighten the acceptance criteria',
      sessionKey: 'sess:a',
    });
    assert.match(rec.id, /^ann_[0-9a-f]{8}$/);
    assert.equal(rec.type, 'requirement');
    assert.equal(rec.targetId, 'req_1234abcd');
    assert.equal(rec.body, 'Tighten the acceptance criteria');
    assert.equal(rec.status, 'open'); // default
    assert.equal(rec.severity, undefined);
    assert.deepEqual(rec.linkedMemoryIds, []);
    assert.equal(rec.workspaceRoot, workspace);
    assert.equal(rec.sessionKey, 'sess:a');
    assert.equal(typeof rec.createdAt, 'string');
    assert.equal(rec.createdAt, rec.updatedAt); // fresh record

    const back = getAnnotation(workspace, rec.id);
    assert.deepEqual(back, rec);
  });
});

test('annotationStore: empty body is rejected', () => {
  withTempWorkspace((workspace) => {
    assert.throws(() => createAnnotation(workspace, { type: 'file', body: '   ' }), /non-empty/);
  });
});

test('annotationStore: anchor + suggested code + severity are stored only when present', () => {
  withTempWorkspace((workspace) => {
    const anchored = createAnnotation(workspace, {
      type: 'file',
      body: 'Off-by-one here',
      anchor: { filePath: 'src/app.ts', startLine: 12, endLine: 14 },
      severity: 'high',
      suggestedText: 'for (let i = 0; i < n; i++) {}',
    });
    assert.deepEqual(anchored.anchor, { filePath: 'src/app.ts', startLine: 12, endLine: 14 });
    assert.equal(anchored.severity, 'high');
    assert.equal(anchored.suggestedText, 'for (let i = 0; i < n; i++) {}');

    // A global comment with an empty anchor object drops the anchor entirely.
    const global = createAnnotation(workspace, { type: 'plan', body: 'Overall LGTM', anchor: {} });
    assert.equal(global.anchor, undefined);
    assert.equal('anchor' in global, false);
  });
});

test('annotationStore: status transitions open → accepted/rejected/resolved/ignored persist + bump updatedAt', async () => {
  await new Promise<void>((resolve) => {
    withTempWorkspace((workspace) => {
      const rec = createAnnotation(workspace, { type: 'diff', body: 'Rename this var' });
      assert.equal(rec.status, 'open');
      for (const status of ['accepted', 'rejected', 'resolved', 'ignored'] as const) {
        const tick = Date.now();
        while (Date.now() === tick) { /* spin ~1ms so updatedAt advances */ }
        const updated = setStatus(workspace, rec.id, status);
        assert.ok(updated);
        assert.equal(updated.status, status);
        assert.equal(updated.createdAt, rec.createdAt); // createdAt frozen
        assert.ok(updated.updatedAt > rec.updatedAt); // bumped
        // Persisted, not just returned.
        assert.equal(getAnnotation(workspace, rec.id)!.status, status);
      }
      resolve();
    });
  });
});

test('annotationStore: setStatus / updateAnnotation return undefined for a missing id', () => {
  withTempWorkspace((workspace) => {
    assert.equal(setStatus(workspace, 'ann_deadbeef', 'accepted'), undefined);
    assert.equal(updateAnnotation(workspace, 'ann_deadbeef', { body: 'x' }), undefined);
  });
});

test('annotationStore: id/workspaceRoot/createdAt cannot be patched', () => {
  withTempWorkspace((workspace) => {
    const rec = createAnnotation(workspace, { type: 'message', body: 'Immutable fields' });
    const updated = updateAnnotation(workspace, rec.id, {
      id: 'ann_hacked',
      workspaceRoot: '/elsewhere',
      createdAt: '1999-01-01T00:00:00.000Z',
      status: 'resolved',
    } as Parameters<typeof updateAnnotation>[2]);
    assert.ok(updated);
    assert.equal(updated.id, rec.id);
    assert.equal(updated.workspaceRoot, workspace);
    assert.equal(updated.createdAt, rec.createdAt);
    assert.equal(updated.status, 'resolved'); // the legit field did apply
  });
});

test('annotationStore: list filters by target kind / target id / status / severity / session / file', () => {
  withTempWorkspace((workspace) => {
    const a = createAnnotation(workspace, {
      type: 'file',
      body: 'A',
      sessionKey: 'sess:1',
      severity: 'high',
      anchor: { filePath: 'src/a.ts', startLine: 1 },
    });
    const tick = Date.now();
    while (Date.now() === tick) { /* spin so b is strictly newer */ }
    const b = createAnnotation(workspace, {
      type: 'requirement',
      targetId: 'req_x',
      body: 'B',
      sessionKey: 'sess:2',
      severity: 'low',
    });
    setStatus(workspace, b.id, 'accepted');

    // No filter → both, newest first (b created after a).
    const all = listAnnotations(workspace);
    assert.equal(all.length, 2);
    assert.equal(all[0].id, b.id);

    // Target kind.
    assert.deepEqual(listAnnotations(workspace, { targetKind: 'file' }).map((r) => r.id), [a.id]);
    // Target id.
    assert.deepEqual(listAnnotations(workspace, { targetId: 'req_x' }).map((r) => r.id), [b.id]);
    // Status.
    assert.deepEqual(listAnnotations(workspace, { status: 'accepted' }).map((r) => r.id), [b.id]);
    assert.deepEqual(listAnnotations(workspace, { status: 'open' }).map((r) => r.id), [a.id]);
    // Severity.
    assert.deepEqual(listAnnotations(workspace, { severity: 'high' }).map((r) => r.id), [a.id]);
    // Session.
    assert.deepEqual(listAnnotations(workspace, { sessionKey: 'sess:2' }).map((r) => r.id), [b.id]);
    // File anchor.
    assert.deepEqual(listAnnotations(workspace, { file: 'src/a.ts' }).map((r) => r.id), [a.id]);
    // ANDed filters that exclude everything.
    assert.equal(listAnnotations(workspace, { targetKind: 'file', status: 'accepted' }).length, 0);
  });
});

test('annotationStore: workspaces are isolated — two roots do not bleed', () => {
  withTempWorkspace((workspaceA) => {
    withTempWorkspace((workspaceB) => {
      const a = createAnnotation(workspaceA, { type: 'plan', body: 'Only in A' });
      const b = createAnnotation(workspaceB, { type: 'plan', body: 'Only in B' });
      assert.equal(getAnnotation(workspaceA, b.id), undefined);
      assert.equal(getAnnotation(workspaceB, a.id), undefined);
      assert.deepEqual(listAnnotations(workspaceA).map((r) => r.body), ['Only in A']);
      assert.deepEqual(listAnnotations(workspaceB).map((r) => r.body), ['Only in B']);
    });
  });
});

test('annotationStore: linkAnnotation pushes unique memory ids (no dupes)', () => {
  withTempWorkspace((workspace) => {
    const rec = createAnnotation(workspace, { type: 'review-finding', targetId: 'f1', body: 'Linked' });
    linkAnnotation(workspace, rec.id, { memoryId: 'm1' });
    linkAnnotation(workspace, rec.id, { memoryId: 'm1' }); // dup — ignored
    linkAnnotation(workspace, rec.id, { memoryId: 'm2' });
    linkAnnotation(workspace, rec.id, {}); // no-op
    const r = getAnnotation(workspace, rec.id);
    assert.ok(r);
    assert.deepEqual(r.linkedMemoryIds, ['m1', 'm2']);
  });
});

test('annotationStore: linkAnnotation returns undefined for a missing id', () => {
  withTempWorkspace((workspace) => {
    assert.equal(linkAnnotation(workspace, 'ann_missing', { memoryId: 'm1' }), undefined);
  });
});

test('annotationStore: deleteAnnotation removes the record and reports success', () => {
  withTempWorkspace((workspace) => {
    const rec = createAnnotation(workspace, { type: 'html', body: 'Temp' });
    assert.equal(deleteAnnotation(workspace, rec.id), true);
    assert.equal(getAnnotation(workspace, rec.id), undefined);
    assert.equal(deleteAnnotation(workspace, rec.id), false); // already gone
  });
});

test('annotationStore: state persists across a fresh read (simulated restart)', () => {
  withTempWorkspace((workspace) => {
    const rec = createAnnotation(workspace, { type: 'markdown', body: 'Durable', severity: 'medium' });
    setStatus(workspace, rec.id, 'accepted');

    const file = getCliStateFile(workspace, 'annotations.json');
    assert.equal(fs.existsSync(file), true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(onDisk[rec.id]);

    const reread = readAnnotationsAll(workspace);
    assert.equal(reread[rec.id].severity, 'medium');
    assert.equal(reread[rec.id].status, 'accepted');
  });
});

test('isAnnotationRecord: accepts a real record and rejects malformed shapes', () => {
  withTempWorkspace((workspace) => {
    const rec = createAnnotation(workspace, {
      type: 'file',
      body: 'Guarded',
      anchor: { filePath: 'x.ts', startLine: 3 },
    });
    assert.equal(isAnnotationRecord(rec), true);
  });
  // Negative controls — no workspace needed.
  assert.equal(isAnnotationRecord(null), false);
  assert.equal(isAnnotationRecord({}), false);
  assert.equal(
    isAnnotationRecord({
      id: 'ann_1', type: 'not-a-kind', // bad enum
      workspaceRoot: '/w', body: 'x', status: 'open', linkedMemoryIds: [],
      createdAt: 'now', updatedAt: 'now',
    }),
    false,
  );
  assert.equal(
    isAnnotationRecord({
      id: 'ann_1', type: 'file',
      workspaceRoot: '/w', body: 'x', status: 'nope', // bad status
      linkedMemoryIds: [], createdAt: 'now', updatedAt: 'now',
    }),
    false,
  );
  assert.equal(
    isAnnotationRecord({
      id: 'ann_1', type: 'file',
      workspaceRoot: '/w', body: 'x', status: 'open',
      anchor: { startLine: 'three' }, // bad anchor field type
      linkedMemoryIds: [], createdAt: 'now', updatedAt: 'now',
    }),
    false,
  );
});

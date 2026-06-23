import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAnnotationService, AnnotationService } from '../annotation/service.js';
import { readAnnotationsAll, getAnnotation, listAnnotations } from '../annotation/annotationStore.js';

test('AnnotationService is a per-workspace facade — delegates to the annotation store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-svc-'));
  try {
    const svc = createAnnotationService(ws);
    assert.ok(svc instanceof AnnotationService);
    assert.deepEqual(svc.readAll(), readAnnotationsAll(ws));
    assert.equal(svc.list().length, 0);

    const a = svc.create({ type: 'markdown', body: 'needs a clearer title' });
    assert.ok(a.id.startsWith('ann_'));
    assert.deepEqual(svc.get(a.id), getAnnotation(ws, a.id));
    assert.deepEqual(svc.list(), listAnnotations(ws));

    assert.equal(svc.update(a.id, { body: 'edited' })?.body, 'edited');
    assert.equal(svc.setStatus(a.id, 'resolved')?.status, 'resolved');
    assert.equal(svc.addComment(a.id, 'thanks')?.comments?.length, 1);
    assert.equal(svc.link(a.id, { memoryId: 'mem-1' })?.linkedMemoryIds.includes('mem-1'), true);

    assert.equal(svc.delete(a.id), true);
    assert.equal(svc.get(a.id), undefined);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

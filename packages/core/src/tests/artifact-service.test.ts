import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArtifactService, ArtifactService } from '../artifact/service.js';
import { readArtifactsAll, getArtifact, listArtifacts } from '../artifact/artifactStore.js';

test('ArtifactService is a per-workspace facade — delegates to the artifact store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'art-svc-'));
  try {
    const svc = createArtifactService(ws);
    assert.ok(svc instanceof ArtifactService);
    assert.deepEqual(svc.readAll(), readArtifactsAll(ws));
    assert.equal(svc.list().length, 0);

    const a = svc.create({ kind: 'markdown-report', title: 'spec', content: 'v1 body' });
    assert.ok(a.id.startsWith('art_'));
    assert.deepEqual(svc.get(a.id), getArtifact(ws, a.id));
    assert.deepEqual(svc.list(), listArtifacts(ws));
    assert.equal(svc.listVersions(a.id).length, 1);

    // A content edit appends a version (§AV-1).
    const updated = svc.update(a.id, { content: 'v2 body' });
    assert.equal(updated?.currentVersion, 2);
    assert.equal(svc.getVersion(a.id, 1)?.content, 'v1 body');

    // Revert is append-only: restores v1's content as a new version.
    const reverted = svc.revert(a.id, 1);
    assert.equal(reverted?.content, 'v1 body');
    assert.equal(reverted?.currentVersion, 3);

    assert.equal(svc.link(a.id, { memoryId: 'mem-1' })?.linkedMemoryIds.includes('mem-1'), true);
    assert.equal(svc.delete(a.id), true);
    assert.equal(svc.get(a.id), undefined);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

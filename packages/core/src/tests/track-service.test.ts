import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTrackService, TrackService } from '../track/service/service.js';
import { getProject, getWorkItem, listWorkItems } from '../track/trackStore.js';

test('TrackService is a per-workspace facade — delegates to the track store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'track-svc-'));
  try {
    const svc = createTrackService(ws);
    assert.ok(svc instanceof TrackService);

    const project = svc.ensureProject({ name: 'BrainRouter', key: 'BR' });
    assert.ok(project);
    assert.deepEqual(svc.getProject(), getProject(ws));

    const item = svc.createWorkItem({ title: 'Port the track store' });
    assert.ok(item.key);
    assert.deepEqual(svc.getWorkItem(item.key), getWorkItem(ws, item.key));
    assert.deepEqual(svc.listWorkItems(), listWorkItems(ws));
    assert.equal(svc.listWorkItems().length, 1);

    const updated = svc.updateWorkItem(item.key, { title: 'Port the track store (done)' });
    assert.equal(updated?.title, 'Port the track store (done)');

    // No code links yet → empty (delegation still exercised).
    assert.deepEqual(svc.findByCodeLink({ kind: 'file', ref: 'src/track/service.ts' }), []);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

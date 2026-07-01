import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPackService, PackService } from '../pack/service.js';
import { readPackState, isPackEnabled } from '../pack/packStore.js';

test('PackService is a per-workspace facade — delegates to the pack store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-svc-'));
  try {
    const svc = createPackService(ws);
    assert.ok(svc instanceof PackService);
    assert.deepEqual(svc.readState(), readPackState(ws));
    assert.deepEqual(svc.readState().enabled, []);

    svc.enable('design-pack');
    assert.equal(svc.isEnabled(svc.readState().enabled, 'design-pack'), true);
    assert.deepEqual(svc.readState(), readPackState(ws));

    svc.disable('design-pack');
    assert.equal(svc.isEnabled(svc.readState().enabled, 'design-pack'), false);
    assert.equal(svc.isEnabled(['a', 'b'], 'a'), isPackEnabled(['a', 'b'], 'a'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

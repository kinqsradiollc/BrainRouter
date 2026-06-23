import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHooksService, HooksService } from '../hooks/service.js';
import { readHooks, runHooks, parseHookDecision } from '../hooks/hooksStore.js';

test('HooksService is a per-workspace facade — delegates to the hooks store', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-svc-'));
  try {
    const svc = createHooksService(ws);
    assert.ok(svc instanceof HooksService);
    assert.deepEqual(svc.read(), readHooks(ws));
    assert.equal(svc.read().length, 0);

    const h = svc.add({ event: 'pre-tool', command: 'echo hi' });
    assert.ok(h.id);
    assert.equal(svc.read().length, 1);
    assert.equal(svc.setEnabled(h.id, false), true);
    assert.equal(svc.remove(h.id), true);
    assert.equal(svc.read().length, 0);

    // No hooks registered → no shell is spawned; both return [].
    assert.deepEqual(svc.run('pre-tool'), runHooks(ws, 'pre-tool'));
    assert.equal(svc.parseDecision('not json'), parseHookDecision('not json'));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

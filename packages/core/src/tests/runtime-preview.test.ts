import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCliKnobsCache, setCliKnobOverride } from '../config/config.js';
import {
  listRuntimePreviewPorts,
  registerRuntimePreviewPort,
  removeRuntimePreviewPort,
  resolveRuntimePreviewReservations,
} from '../runtime/index.js';
import { withTempWorkspaceAsync } from './_helpers.js';

function withPreviewPorts(previewPorts: Record<string, number>, fn: () => void): void {
  _resetCliKnobsCache();
  setCliKnobOverride({
    runtime: {
      backend: 'process',
      maxLive: 0,
      archiveOnDispose: true,
      archiveMaxMB: 64,
      archiveKeep: 20,
      jitSecrets: false,
      jitSecretTtlMs: 60_000,
      containerImage: '',
      container: { cpus: 0, memory: '' },
      serve: false,
      serveHost: '127.0.0.1',
      servePort: 8791,
      remoteUrl: '',
      previewPorts,
    },
  });
  try { fn(); }
  finally { _resetCliKnobsCache(); }
}

test('runtime preview reservations reflect configured named ports', () => {
  withPreviewPorts({ app: 5173, docs: 4173 }, () => {
    assert.deepEqual(resolveRuntimePreviewReservations(), [
      { name: 'app', port: 5173, url: 'http://127.0.0.1:5173' },
      { name: 'docs', port: 4173, url: 'http://127.0.0.1:4173' },
    ]);
  });
});

test('runtime previews register, update, filter, and remove by runtime', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    withPreviewPorts({ app: 5173 }, () => {
      const first = registerRuntimePreviewPort(ws, {
        runtimeId: 'rt_1',
        name: 'App',
        now: '2026-01-01T00:00:00.000Z',
      });
      assert.equal(first.name, 'app');
      assert.equal(first.url, 'http://127.0.0.1:5173');

      const updated = registerRuntimePreviewPort(ws, {
        runtimeId: 'rt_1',
        name: 'app',
        port: 3000,
        host: 'localhost',
        now: '2026-01-01T00:01:00.000Z',
      });
      assert.equal(updated.registeredAt, first.registeredAt);
      assert.equal(updated.updatedAt, '2026-01-01T00:01:00.000Z');
      assert.equal(updated.url, 'http://localhost:3000');

      registerRuntimePreviewPort(ws, { runtimeId: 'rt_2', name: 'app', port: 4000 });
      assert.equal(listRuntimePreviewPorts(ws).length, 2);
      assert.deepEqual(listRuntimePreviewPorts(ws, 'rt_1').map((preview) => preview.url), ['http://localhost:3000']);

      assert.equal(removeRuntimePreviewPort(ws, 'rt_1', 'app'), true);
      assert.deepEqual(listRuntimePreviewPorts(ws, 'rt_1'), []);
      assert.equal(removeRuntimePreviewPort(ws, 'rt_1', 'app'), false);
    });
  });
});

test('runtime preview registration rejects unknown names without an explicit port', async () => {
  await withTempWorkspaceAsync(async (ws) => {
    withPreviewPorts({}, () => {
      assert.throws(
        () => registerRuntimePreviewPort(ws, { runtimeId: 'rt_1', name: 'app' }),
        /preview_port_invalid/,
      );
    });
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCliKnobsCache, setCliKnobOverride } from '@kinqs/brainrouter-core/config';
import {
  createCliRuntimeRunnerClient,
  formatCliRuntimeRunnerSummary,
  summarizeCliRuntimeRunner,
} from '../runtime/runner/runnerClient.js';
import { withTempWorkspace } from './_helpers.js';

test('createCliRuntimeRunnerClient defaults to the in-process runner', () => {
  withTempWorkspace((workspace) => {
    _resetCliKnobsCache();
    const client = createCliRuntimeRunnerClient({
      workspaceRoot: workspace,
      executeTurn: async () => 'ok',
    });
    assert.equal(client.mode, 'in-process');
    assert.deepEqual(summarizeCliRuntimeRunner(client, ''), { mode: 'in-process', remoteUrl: null });
  });
});

test('createCliRuntimeRunnerClient opts into a remote runner from config', () => {
  withTempWorkspace((workspace) => {
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
        remoteUrl: 'http://127.0.0.1:9999',
        previewPorts: {},
      },
    });
    const client = createCliRuntimeRunnerClient({
      workspaceRoot: workspace,
      executeTurn: async () => 'ok',
    });
    assert.equal(client.mode, 'remote');
    assert.deepEqual(
      summarizeCliRuntimeRunner(client, 'http://127.0.0.1:9999'),
      { mode: 'remote', remoteUrl: 'http://127.0.0.1:9999' },
    );
    _resetCliKnobsCache();
  });
});

test('formatCliRuntimeRunnerSummary renders local and remote modes', () => {
  assert.equal(formatCliRuntimeRunnerSummary({ mode: 'in-process', remoteUrl: null }), 'Runner mode: in-process\n');
  assert.equal(
    formatCliRuntimeRunnerSummary({ mode: 'remote', remoteUrl: 'http://127.0.0.1:8791' }),
    'Runner mode: remote\nRemote URL: http://127.0.0.1:8791\n',
  );
});

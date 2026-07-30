import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ConnectorRecord } from '@kinqs/brainrouter-types';
import {
  buildCheckpointRunner,
  defaultEnvTokenResolver,
  type ConnectorRuntimeHost,
} from '../connectors/index.js';

function connector(overrides: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: 'conn_host',
    name: 'Host boundary',
    source: 'filesystem',
    status: 'active',
    config: {},
    credential: { mode: 'none' },
    flows: ['checkpoint'],
    workspaceRoot: '/tmp/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('connector checkpoint policy does not read process environment or cwd directly', () => {
  const runner = fs.readFileSync(
    new URL('../connectors/runtime/runCheckpoint.js', import.meta.url),
    'utf8',
  );
  const adapter = fs.readFileSync(
    new URL('../connectors/runtime/host/nodeConnectorRuntimeHost.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(runner, /process\.(?:env|cwd)/);
  assert.match(runner, /nodeConnectorRuntimeHost/);
  assert.match(adapter, /process\.env/);
  assert.match(adapter, /process\.cwd/);
});

test('connector runtime host supplies credential and relative-root context', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-host-'));
  try {
    const docs = path.join(root, 'docs');
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(docs, 'guide.md'), '# Guide\n');
    const runtimeHost: ConnectorRuntimeHost = {
      environmentValue: (name) => name === 'CONNECTOR_TOKEN' ? 'host-token' : undefined,
      currentWorkingDirectory: () => root,
    };
    assert.deepEqual(defaultEnvTokenResolver(connector({
      credential: { mode: 'static', ref: 'CONNECTOR_TOKEN' },
    }), 'Files', runtimeHost), { token: 'host-token' });

    const run = buildCheckpointRunner({ runtimeHost });
    const result = await run(connector({ config: { roots: ['docs'] } }));
    assert.equal(result.documents.length, 1);
    assert.equal(result.documents[0]?.title, 'guide.md');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

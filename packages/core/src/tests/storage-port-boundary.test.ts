import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import type {
  FileMutationRecord,
  RecoverableState,
} from '../storage/contracts.js';
import type { StoragePersistencePort } from '../storage/ports/storagePersistencePort.js';
import { createStorageService } from '../storage/service.js';

const sourceExtension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';

test('storage service is port-driven and keeps filesystem adapters outside policy', () => {
  const serviceSource = fs.readFileSync(
    new URL(`../storage/service${sourceExtension}`, import.meta.url),
    'utf8',
  );
  const policySource = fs.readFileSync(
    new URL(`../storage/policy/restorePlan${sourceExtension}`, import.meta.url),
    'utf8',
  );
  const adapterSource = fs.readFileSync(
    new URL(
      `../storage/adapters/nodeStoragePersistenceAdapter${sourceExtension}`,
      import.meta.url,
    ),
    'utf8',
  );

  assert.doesNotMatch(`${serviceSource}\n${policySource}`, /node:fs|storage\/store/);
  assert.match(serviceSource, /StoragePersistencePort|nodeStoragePersistenceAdapter/);
  assert.match(adapterSource, /checkpointStore/);
  assert.match(adapterSource, /fileSnapshotStore/);
});

test('storage service binds workspace scope while an injected port owns persistence', () => {
  const calls: Array<{ operation: string; workspaceRoot: string; sessionKey: string }> = [];
  const mutations: FileMutationRecord[] = [];
  const recoverable: RecoverableState = { crashed: null, offline: [] };
  const port: StoragePersistencePort = {
    beginTurn: (workspaceRoot, sessionKey) => calls.push({ operation: 'begin', workspaceRoot, sessionKey }),
    endTurn: (workspaceRoot, sessionKey) => calls.push({ operation: 'end', workspaceRoot, sessionKey }),
    queueOffline: (workspaceRoot, sessionKey) => calls.push({ operation: 'queue', workspaceRoot, sessionKey }),
    readOfflineQueue: () => [],
    clearOfflineQueue: (workspaceRoot, sessionKey) => calls.push({ operation: 'clear', workspaceRoot, sessionKey }),
    readRecoverable: () => recoverable,
    recordFileMutation: (workspaceRoot, sessionKey, record) => {
      calls.push({ operation: 'mutation', workspaceRoot, sessionKey });
      mutations.push(record);
    },
    readFileMutations: () => mutations,
  };
  const service = createStorageService('/workspace', port);

  service.beginTurn('session:a', 'prompt', '2026-01-01T00:00:00.000Z');
  service.recordFileMutation('session:a', { turn: 2, path: 'src/a.ts', priorContent: 'before' });
  service.endTurn('session:a');

  assert.deepEqual(calls, [
    { operation: 'begin', workspaceRoot: '/workspace', sessionKey: 'session:a' },
    { operation: 'mutation', workspaceRoot: '/workspace', sessionKey: 'session:a' },
    { operation: 'end', workspaceRoot: '/workspace', sessionKey: 'session:a' },
  ]);
  assert.deepEqual(service.readFileMutations('session:a'), mutations);
  assert.deepEqual(service.planRestore(mutations, 1), [
    { path: 'src/a.ts', action: 'write', content: 'before' },
  ]);
});

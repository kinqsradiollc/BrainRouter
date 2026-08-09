import assert from 'node:assert/strict';
import test from 'node:test';

import type { HostContext } from './context.js';
import { buildQueries } from './queries.js';

test('action:clear awaits one pinned Agent session drain before clearing and is repeat-safe', async () => {
  let release!: () => void;
  const drainGate = new Promise<void>((resolve) => { release = resolve; });
  const lifecycle: string[] = [];
  let drain: Promise<void> | undefined;
  const agent = {
    endSession: () => {
      if (!drain) {
        lifecycle.push('session-end');
        drain = drainGate;
      }
      return drain;
    },
    clearHistory: () => { lifecycle.push('clear-history'); },
  };

  // `buildQueries` closes over a large host bag, but action:clear reads only
  // getActiveAgent. The remaining functions are inert placeholders so this
  // exercises the real registered handler without booting Electron services.
  const fallback = () => undefined;
  const values: Record<PropertyKey, unknown> = {
    ghJson: async () => ({}),
    getActiveAgent: () => agent,
    workspaceRoot: process.cwd(),
    wsGit: {},
    collectWorkingDiff: async () => ({ diff: '', files: [] }),
  };
  const ctx = new Proxy(values, {
    get: (target, key) => Reflect.has(target, key) ? Reflect.get(target, key) : fallback,
  }) as unknown as HostContext;
  const clear = buildQueries(ctx)['action:clear']!;

  const first = clear({});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle, ['session-end'], 'history stays intact while the bounded drain is pending');

  release();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(lifecycle, ['session-end', 'clear-history']);

  assert.deepEqual(await clear({}), { ok: true });
  assert.deepEqual(
    lifecycle,
    ['session-end', 'clear-history', 'clear-history'],
    'repeating clear reuses Agent.endSession idempotence and remains safe',
  );
});

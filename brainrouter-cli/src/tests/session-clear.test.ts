import assert from 'node:assert/strict';
import test from 'node:test';

import type { CommandContext } from '../cli/commands/_context.js';
import { tryHandleSessionCommand } from '../cli/commands/session/index.js';

test('/clear awaits the idempotent session-end drain before destroying history', async () => {
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
  const ctx = {
    command: '/clear',
    args: [],
    agent,
  } as unknown as CommandContext;

  const originalLog = console.log;
  console.log = () => {};
  try {
    const first = tryHandleSessionCommand(ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(lifecycle, ['session-end'], 'history stays intact while the bounded drain is pending');

    release();
    assert.equal(await first, true);
    assert.deepEqual(lifecycle, ['session-end', 'clear-history']);

    assert.equal(await tryHandleSessionCommand(ctx), true);
    assert.deepEqual(
      lifecycle,
      ['session-end', 'clear-history', 'clear-history'],
      'repeating clear reuses Agent.endSession idempotence and remains safe',
    );
  } finally {
    console.log = originalLog;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeBuiltinToolRuntime } from './runtime.js';

function runtimeContext() {
  return {
    silent: false,
    agentDepth: 0,
    tier: 'chat',
    terminalUsePort: {
      list: () => [{ id: 't1', shell: '/bin/zsh', pid: 42, start: 0, next: 18, alive: true }],
      read: (_id: string, fromOffset: number) => ({
        chunk: fromOffset === 0 ? '\u001b[31mhello\u001b[0m\r\nworld' : 'world',
        next: 18,
        alive: true,
        dropped: 0,
      }),
      write: () => true,
    },
  };
}

test('terminal_list returns metadata for host-owned sessions', async () => {
  const output = await invokeBuiltinToolRuntime.call(runtimeContext(), 'terminal_list', {});
  assert.deepEqual(JSON.parse(output), [{
    id: 't1',
    shell: '/bin/zsh',
    pid: 42,
    start: 0,
    next: 18,
    alive: true,
  }]);
});

test('terminal_read strips terminal control sequences and returns a cursor', async () => {
  const output = await invokeBuiltinToolRuntime.call(runtimeContext(), 'terminal_read', {
    id: 't1',
    fromOffset: 0,
  });
  assert.deepEqual(JSON.parse(output), {
    id: 't1',
    found: true,
    chunk: 'hello\nworld',
    nextOffset: 18,
    alive: true,
    dropped: 0,
  });
});

test('terminal tools fail closed for silent child agents', async () => {
  const ctx = { ...runtimeContext(), silent: true, agentDepth: 1 };
  const output = await invokeBuiltinToolRuntime.call(ctx, 'terminal_read', { id: 't1' });
  assert.match(output, /unavailable outside the active top-level/);
});

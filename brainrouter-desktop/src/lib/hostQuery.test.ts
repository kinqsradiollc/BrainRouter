/**
 * DESK-PK — compatibility checks for nullable self-contained panel queries.
 * The shared transport owns event parsing; this suite pins the hostQuery
 * contract that Project Knowledge and legacy panels consume.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { hostQuery } from './hostQuery.js';

interface QueryCommand {
  kind: 'query';
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

function installBridge(t: TestContext): {
  sent: QueryCommand[];
  emit: (message: unknown) => void;
  offCalls: () => number;
} {
  const original = globalThis.window;
  const sent: QueryCommand[] = [];
  let listener: ((message: unknown) => void) | undefined;
  let unsubscribed = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      brainrouter: {
        send: (command: QueryCommand) => { sent.push(command); },
        onEvent: (next: (message: unknown) => void) => {
          listener = next;
          return () => { unsubscribed += 1; };
        },
      },
    },
  });
  t.after(() => {
    if (original === undefined) delete (globalThis as { window?: Window }).window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: original });
  });
  return {
    sent,
    emit: (message) => {
      assert.ok(listener);
      listener(message);
    },
    offCalls: () => unsubscribed,
  };
}

test('accepts bare development-bridge results', async (t) => {
  const bridge = installBridge(t);
  const pending = hostQuery<{ state: string }>('knowledge-workspace', undefined, '/workspace/a');
  const command = bridge.sent[0];

  bridge.emit({ kind: 'query-result', id: command.id, ok: true, result: { state: 'ready' } });

  assert.deepEqual(await pending, { state: 'ready' });
  assert.equal(bridge.offCalls(), 1);
});

test('accepts wrapped host results from the expected workspace', async (t) => {
  const bridge = installBridge(t);
  const pending = hostQuery<{ state: string }>('knowledge-workspace', {}, '/workspace/a');
  const command = bridge.sent[0];

  bridge.emit({
    workspaceRoot: '/workspace/b',
    event: { kind: 'query-result', id: command.id, ok: true, result: { state: 'wrong' } },
  });
  assert.equal(bridge.offCalls(), 0);
  bridge.emit({
    workspaceRoot: '/workspace/a',
    event: { kind: 'query-result', id: command.id, ok: true, result: { state: 'ready' } },
  });

  assert.deepEqual(await pending, { state: 'ready' });
  assert.equal(bridge.offCalls(), 1);
});

test('preserves nullable legacy behavior for a failed query', async (t) => {
  const bridge = installBridge(t);
  const pending = hostQuery('knowledge-workspace');
  const command = bridge.sent[0];

  bridge.emit({ kind: 'query-result', id: command.id, ok: false, error: 'signed out' });

  assert.equal(await pending, null);
  assert.equal(bridge.offCalls(), 1);
});

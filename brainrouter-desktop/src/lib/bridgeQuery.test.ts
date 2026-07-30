import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeQuery } from './bridgeQuery.js';

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

test('ignores a matching query id from a different workspace', async (t) => {
  const bridge = installBridge(t);
  const pending = bridgeQuery<{ value: string }>('workspace-onboarding-propose', {}, 100, '/workspace/a');
  assert.equal(bridge.sent.length, 1);
  const { id } = bridge.sent[0];

  bridge.emit({
    workspaceRoot: '/workspace/b',
    event: { kind: 'query-result', id, ok: true, result: { value: 'wrong' } },
  });
  assert.equal(bridge.offCalls(), 0);

  bridge.emit({
    workspaceRoot: '/workspace/a',
    event: { kind: 'query-result', id, ok: true, result: { value: 'right' } },
  });
  assert.deepEqual(await pending, { value: 'right' });
  assert.equal(bridge.offCalls(), 1);
});

test('accepts the bare query-result shape used by browser development', async (t) => {
  const bridge = installBridge(t);
  const pending = bridgeQuery<number>('demo-query', { sample: true }, 100, '/workspace/a');
  const command = bridge.sent[0];
  assert.equal(command.name, 'demo-query');
  assert.deepEqual(command.args, { sample: true });

  bridge.emit({ kind: 'query-result', id: command.id, ok: true, result: 42 });
  assert.equal(await pending, 42);
  assert.equal(bridge.offCalls(), 1);
});

test('times out and unsubscribes when no authoritative result arrives', async (t) => {
  const bridge = installBridge(t);
  await assert.rejects(
    bridgeQuery('slow-query', undefined, 5, '/workspace/a'),
    /slow-query timed out/,
  );
  assert.equal(bridge.offCalls(), 1);
});

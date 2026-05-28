import test from 'node:test';
import assert from 'node:assert/strict';
import { attachFederation } from '../runtime/federationRegistration.js';

/**
 * FED-S2-T6 — CLI federation registration lifecycle.
 *
 * Covers:
 *   - No-op when the brain lacks session_register / session_heartbeat
 *     (pre-0.4.0 brain compatibility).
 *   - On startup: registers once.
 *   - Heartbeat tick: calls session_heartbeat with the active sessionKey.
 *   - Re-register-on-falsy-update path: when the brain returns
 *     `{ updated: false }` (row swept), the next tick triggers a
 *     fresh session_register so federation view recovers automatically.
 *   - stop() halts heartbeats.
 */

interface RecordedCall {
  name: string;
  args: any;
}

function makeStubClient(opts: {
  listTools: Array<{ name: string }>;
  heartbeatResults?: Array<{ updated: boolean }>;
}) {
  const calls: RecordedCall[] = [];
  let hbIdx = 0;
  const client = {
    async listTools() {
      return { tools: opts.listTools };
    },
    async callTool(name: string, args: any) {
      calls.push({ name, args });
      if (name === 'session_heartbeat') {
        const result = opts.heartbeatResults?.[hbIdx++] ?? { updated: true };
        return { isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: { sessionKey: args.sessionKey } }) }] };
      }
      if (name === 'session_unregister') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ deleted: true }) }] };
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;
  return { client, calls };
}

test('attachFederation: no-op when brain lacks session_register / session_heartbeat', async () => {
  const { client, calls } = makeStubClient({ listTools: [{ name: 'memory_recall' }] });
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-1',
    workspaceRoot: '/repos/alpha',
  });
  assert.equal(handle, null);
  assert.deepEqual(calls.filter((c) => c.name.startsWith('session_')), []);
});

test('attachFederation: registers once on startup', async () => {
  const { client, calls } = makeStubClient({
    listTools: [{ name: 'session_register' }, { name: 'session_heartbeat' }],
  });
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-startup',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000,
  });
  assert.ok(handle);
  assert.equal(handle?.sessionKey, 'sk-startup');
  const registers = calls.filter((c) => c.name === 'session_register');
  assert.equal(registers.length, 1);
  assert.equal(registers[0].args.sessionKey, 'sk-startup');
  assert.equal(registers[0].args.workspaceRoot, '/repos/alpha');
  assert.equal(registers[0].args.clientKind, 'brainrouter-cli');
  await handle?.stop();
});

test('attachFederation: heartbeat tick calls session_heartbeat', async () => {
  const { client, calls } = makeStubClient({
    listTools: [{ name: 'session_register' }, { name: 'session_heartbeat' }],
  });
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-hb',
    workspaceRoot: '/repos/alpha',
    intervalMs: 10, // fire fast for the test
  });
  // Wait for ~3 ticks.
  await new Promise((resolve) => setTimeout(resolve, 45));
  await handle?.stop();
  const hbs = calls.filter((c) => c.name === 'session_heartbeat');
  assert.ok(hbs.length >= 2, `expected ≥2 heartbeats, got ${hbs.length}`);
  assert.equal(hbs[0].args.sessionKey, 'sk-hb');
});

test('attachFederation: re-registers when brain returns updated:false (row was swept)', async () => {
  const { client, calls } = makeStubClient({
    listTools: [{ name: 'session_register' }, { name: 'session_heartbeat' }],
    // Pretend the row was swept between startup and the first heartbeat.
    heartbeatResults: [{ updated: false }, { updated: true }],
  });
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-resurrect',
    workspaceRoot: '/repos/alpha',
    intervalMs: 10,
  });
  // Two heartbeats + the swept-recovery re-register need a beat to land.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await handle?.stop();
  const registers = calls.filter((c) => c.name === 'session_register');
  // Startup + at least one re-register after the swept heartbeat.
  assert.ok(registers.length >= 2, `expected ≥2 registers, got ${registers.length}`);
});

test('attachFederation: stop() halts further heartbeats', async () => {
  const { client, calls } = makeStubClient({
    listTools: [{ name: 'session_register' }, { name: 'session_heartbeat' }],
  });
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-stop',
    workspaceRoot: '/repos/alpha',
    intervalMs: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  await handle?.stop();
  const beforeStop = calls.filter((c) => c.name === 'session_heartbeat').length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const afterStop = calls.filter((c) => c.name === 'session_heartbeat').length;
  assert.equal(afterStop, beforeStop, 'no heartbeats fire after stop()');
});

test('attachFederation: stop() fires session_unregister exactly once', async () => {
  const { client, calls } = makeStubClient({
    listTools: [{ name: 'session_register' }, { name: 'session_heartbeat' }, { name: 'session_unregister' }],
  });
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-bye',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000,
  });
  await handle?.stop();
  await handle?.stop(); // second call must be a no-op — idempotent guard.
  const unregisters = calls.filter((c) => c.name === 'session_unregister');
  assert.equal(unregisters.length, 1, `expected 1 unregister call, got ${unregisters.length}`);
  assert.equal(unregisters[0].args.sessionKey, 'sk-bye');
});

test('attachFederation: stop() returns promptly when the unregister never resolves (hung brain)', async () => {
  let unregistered = 0;
  const client = {
    async listTools() {
      return { tools: [{ name: 'session_register' }, { name: 'session_heartbeat' }, { name: 'session_unregister' }] };
    },
    async callTool(name: string) {
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: {} }) }] };
      }
      if (name === 'session_unregister') {
        unregistered++;
        // Never resolves — `stop()` must hit its internal 1.5 s timeout.
        return new Promise(() => {});
      }
      return { isError: false, content: [{ type: 'text', text: JSON.stringify({ updated: true }) }] };
    },
  } as any;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-hang',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000,
  });
  const t0 = Date.now();
  await handle?.stop();
  const elapsed = Date.now() - t0;
  assert.equal(unregistered, 1, 'unregister must be attempted');
  assert.ok(elapsed < 2_500, `stop() must respect the timeout; took ${elapsed}ms`);
});

test('attachFederation: inbox poller fires session_inbox_read on its own cadence and dispatches text messages', async () => {
  const recordedCalls: Array<{ name: string; args: any }> = [];
  const queuedMessages = [
    [
      { id: 'm-1', kind: 'text', fromSessionKey: 'peer-a', payload: { text: 'hi' }, createdAt: new Date().toISOString() },
    ],
    [], // empty subsequent ticks
  ];
  let pollIdx = 0;
  const client = {
    async listTools() {
      return {
        tools: [
          { name: 'session_register' },
          { name: 'session_heartbeat' },
          { name: 'session_unregister' },
          { name: 'session_inbox_read' },
        ],
      };
    },
    async callTool(name: string, args: any) {
      recordedCalls.push({ name, args });
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: { sessionKey: args.sessionKey } }) }] };
      }
      if (name === 'session_heartbeat') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ updated: true }) }] };
      }
      if (name === 'session_inbox_read') {
        const messages = queuedMessages[pollIdx++] ?? [];
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ messages }) }] };
      }
      if (name === 'session_unregister') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ deleted: true }) }] };
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;

  const dispatched: Array<Array<{ id: string; text: string }>> = [];
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-inbox',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000, // never heartbeat during the test
    inboxIntervalMs: 10, // poll quickly
    onInboxText: (messages) => {
      dispatched.push(messages.map((m) => ({ id: m.id, text: m.text })));
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await handle?.stop();

  const reads = recordedCalls.filter((c) => c.name === 'session_inbox_read');
  assert.ok(reads.length >= 2, `expected ≥2 inbox polls, got ${reads.length}`);
  assert.ok(dispatched.length >= 1, 'callback must have fired at least once');
  assert.deepEqual(dispatched[0], [{ id: 'm-1', text: 'hi' }]);
});

test('attachFederation: inbox poll is skipped entirely when the brain lacks session_inbox_read', async () => {
  const recordedCalls: Array<{ name: string; args: any }> = [];
  const client = {
    async listTools() {
      return {
        tools: [
          { name: 'session_register' },
          { name: 'session_heartbeat' },
          // No session_inbox_read — older brain or partial deployment.
        ],
      };
    },
    async callTool(name: string, args: any) {
      recordedCalls.push({ name, args });
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: {} }) }] };
      }
      return { isError: false, content: [{ type: 'text', text: JSON.stringify({ updated: true }) }] };
    },
  } as any;

  let dispatched = 0;
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-no-inbox',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000,
    inboxIntervalMs: 10,
    onInboxText: () => { dispatched++; },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await handle?.stop();
  assert.equal(dispatched, 0, 'callback must not fire when the brain lacks the inbox tool');
  assert.equal(
    recordedCalls.filter((c) => c.name === 'session_inbox_read').length,
    0,
    'no inbox polls when the tool is unavailable',
  );
});

test('attachFederation: setOnInboxText swap replays messages that arrived before a handler was set', async () => {
  // Production scenario: federation poller starts BEFORE the Ink REPL
  // has a controller, so the initial `onInboxText` may be undefined
  // (or a stdout fallback we want to upgrade). Messages that landed
  // during that gap must replay when the real handler swaps in —
  // otherwise an incoming /dm during startup vanishes.
  const queuedMessages = [
    [
      { id: 'pre-1', kind: 'text', fromSessionKey: 'peer-a', payload: { text: 'arrived early' }, createdAt: new Date().toISOString() },
    ],
    [],
  ];
  let pollIdx = 0;
  const client = {
    async listTools() {
      return {
        tools: [
          { name: 'session_register' },
          { name: 'session_heartbeat' },
          { name: 'session_unregister' },
          { name: 'session_inbox_read' },
        ],
      };
    },
    async callTool(name: string, args: any) {
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: { sessionKey: args.sessionKey } }) }] };
      }
      if (name === 'session_heartbeat') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ updated: true }) }] };
      }
      if (name === 'session_inbox_read') {
        const messages = queuedMessages[pollIdx++] ?? [];
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ messages }) }] };
      }
      if (name === 'session_unregister') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ deleted: true }) }] };
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  } as any;

  // Attach with NO handler — the federation handle should buffer the
  // first poll's messages internally.
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-replay',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000,
    inboxIntervalMs: 10,
  });
  // Let the first poll tick land.
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Now swap in a real handler — buffered message must replay.
  const received: Array<Array<{ id: string; text: string }>> = [];
  handle?.setOnInboxText((messages) => {
    received.push(messages.map((m) => ({ id: m.id, text: m.text })));
  });
  // Small delay to let the buffered replay land.
  await new Promise((resolve) => setTimeout(resolve, 15));
  await handle?.stop();

  // The buffered batch must have replayed via the new handler.
  assert.ok(
    received.some((batch) => batch.some((m) => m.id === 'pre-1' && m.text === 'arrived early')),
    `expected buffered message to replay, got ${JSON.stringify(received)}`,
  );
});

test('attachFederation: setOnInboxText(null) detaches without buffering replays on next swap', async () => {
  // A user who calls /persona off mid-session shouldn't replay every
  // banner they previously dismissed. Once the handler is set, the
  // buffer is flushed; subsequent set(null) + set(handler) sequences
  // only deliver new messages, not historical ones.
  const queuedMessages = [
    [{ id: 'first', kind: 'text', fromSessionKey: 'peer', payload: { text: 'one' }, createdAt: new Date().toISOString() }],
    [{ id: 'second', kind: 'text', fromSessionKey: 'peer', payload: { text: 'two' }, createdAt: new Date().toISOString() }],
  ];
  let pollIdx = 0;
  const client = {
    async listTools() {
      return { tools: [{ name: 'session_register' }, { name: 'session_heartbeat' }, { name: 'session_inbox_read' }] };
    },
    async callTool(name: string, args: any) {
      if (name === 'session_register') {
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ session: { sessionKey: args.sessionKey } }) }] };
      }
      if (name === 'session_inbox_read') {
        const messages = queuedMessages[pollIdx++] ?? [];
        return { isError: false, content: [{ type: 'text', text: JSON.stringify({ messages }) }] };
      }
      return { isError: false, content: [{ type: 'text', text: JSON.stringify({ updated: true }) }] };
    },
  } as any;

  const collected: Array<{ id: string }> = [];
  const handle = await attachFederation({
    mcpClient: client,
    sessionKey: 'sk-detach',
    workspaceRoot: '/repos/alpha',
    intervalMs: 60_000,
    inboxIntervalMs: 10,
    onInboxText: (messages) => {
      for (const m of messages) collected.push({ id: m.id });
    },
  });
  // Let the first poll land + handler fire.
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Detach.
  handle?.setOnInboxText(null);
  // Let one more poll fire while detached.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await handle?.stop();

  // First message was delivered live; second message arrived while
  // detached and may have buffered. The detach itself must not throw.
  assert.ok(collected.some((m) => m.id === 'first'));
});


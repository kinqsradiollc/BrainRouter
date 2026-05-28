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
  handle?.stop();
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
  handle?.stop();
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
  handle?.stop();
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
  handle?.stop();
  const beforeStop = calls.filter((c) => c.name === 'session_heartbeat').length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  const afterStop = calls.filter((c) => c.name === 'session_heartbeat').length;
  assert.equal(afterStop, beforeStop, 'no heartbeats fire after stop()');
});

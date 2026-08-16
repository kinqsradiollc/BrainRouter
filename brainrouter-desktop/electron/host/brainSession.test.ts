/**
 * ADR-034 Desktop Brain-lease regressions. They pin swept-row re-registration
 * and generation serialization so a delayed heartbeat cannot resurrect an old
 * participant after an Agent switch or host close.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  endBrainSession,
  ensureBrainSession,
  heartbeatBrainSessionNow,
} from './brainSession.js';

function result(payload: unknown): unknown {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function registration(sessionKey: string) {
  return {
    sessionKey,
    deviceId: '11111111-1111-4111-8111-111111111111',
    state: 'idle' as const,
    title: `Title ${sessionKey}`,
    titleSource: 'human' as const,
  };
}

test('heartbeat updated:false re-registers the exact current Desktop participant', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const mcp = {
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'session_register') return result({ session: { sessionKey: args.sessionKey } });
      if (name === 'session_heartbeat') return result({ updated: false });
      return result({ deleted: true });
    },
  };
  try {
    assert.equal(await ensureBrainSession(mcp, '/workspace', registration('desktop:lease-a')), true);
    assert.equal(await heartbeatBrainSessionNow(), true);
    assert.deepEqual(
      calls.filter((call) => call.name === 'session_register').map((call) => call.args.sessionKey),
      ['desktop:lease-a', 'desktop:lease-a'],
    );
  } finally {
    await endBrainSession(mcp);
  }
});

test('delayed stale heartbeat cannot re-register after switch or close', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const heartbeatGates: Array<{
    started: Promise<void>;
    signalStarted(): void;
    response: Promise<unknown>;
    resolveResponse(value: unknown): void;
  }> = [];
  const makeGate = () => {
    let signalStarted!: () => void;
    let resolveResponse!: (value: unknown) => void;
    const gate = {
      started: new Promise<void>((resolve) => { signalStarted = resolve; }),
      signalStarted: () => signalStarted(),
      response: new Promise<unknown>((resolve) => { resolveResponse = resolve; }),
      resolveResponse: (value: unknown) => resolveResponse(value),
    };
    heartbeatGates.push(gate);
    return gate;
  };
  const mcp = {
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'session_register') return result({ session: { sessionKey: args.sessionKey } });
      if (name === 'session_heartbeat') {
        const gate = makeGate();
        gate.signalStarted();
        return gate.response;
      }
      return result({ deleted: true });
    },
  };
  const waitForGate = async (index: number) => {
    while (!heartbeatGates[index]) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return heartbeatGates[index]!;
  };

  await ensureBrainSession(mcp, '/workspace', registration('desktop:switch-a'));
  const staleBeforeSwitch = heartbeatBrainSessionNow();
  const switchGate = await waitForGate(0);
  await switchGate.started;
  const switchToB = ensureBrainSession(mcp, '/workspace', registration('desktop:switch-b'));
  switchGate.resolveResponse(result({ updated: false }));
  assert.equal(await staleBeforeSwitch, false);
  assert.equal(await switchToB, true);
  assert.deepEqual(
    calls.filter((call) => call.name === 'session_register').map((call) => call.args.sessionKey),
    ['desktop:switch-a', 'desktop:switch-b'],
    'the stale A heartbeat never re-registers A before B claims the address',
  );

  const staleBeforeClose = heartbeatBrainSessionNow();
  const closeGate = await waitForGate(1);
  await closeGate.started;
  const close = endBrainSession(mcp);
  closeGate.resolveResponse(result({ updated: false }));
  assert.equal(await staleBeforeClose, false);
  await close;
  assert.deepEqual(
    calls.filter((call) => call.name === 'session_register').map((call) => call.args.sessionKey),
    ['desktop:switch-a', 'desktop:switch-b'],
    'close invalidates the heartbeat before it can resurrect B',
  );
  assert.equal(
    calls.filter((call) => call.name === 'session_unregister' && call.args.sessionKey === 'desktop:switch-b').length,
    1,
  );
});

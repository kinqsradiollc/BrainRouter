import test from 'node:test';
import assert from 'node:assert/strict';
import { tryHandleOrchestrationCommand } from '../cli/commands/orchestration.js';

function toolResult(payload: unknown) {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function makeContext(calls: Array<{ name: string; args: any }>, sessions: Array<{ sessionKey: string }>) {
  const mcpClient = {
    async callTool(name: string, args: any) {
      calls.push({ name, args });
      if (name === 'session_list') return toolResult({ sessions });
      if (name === 'session_send') return toolResult({ delivered: 1, ids: ['msg-1'] });
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  };
  return {
    command: '/dm',
    args: [] as string[],
    agent: {
      sessionKey: 'chat-session',
      getFederationSessionKey: () => 'from-session',
    },
    mcpClient,
    config: {},
    rl: {},
    repl: {
      refreshPromptForMode() {},
      isProcessing: () => false,
      runAgentTurn() {},
      async runAgentTurnAsync() {},
    },
  } as any;
}

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test('/dm resolves a unique session prefix before sending', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const target = 'fa240817-4c3a-4ed5-88ca-000000000001';
  const ctx = makeContext(calls, [{ sessionKey: target }]);
  ctx.args = ['fa240817-4c3', 'find', 'the', 'vulnerabilities'];

  let handled = false;
  await captureLogs(async () => {
    handled = await tryHandleOrchestrationCommand(ctx);
  });

  assert.equal(handled, true);
  const send = calls.find((c) => c.name === 'session_send');
  assert.equal(send?.args.to, target);
  assert.equal(send?.args.payload.text, 'find the vulnerabilities');
});

test('/dm refuses an ambiguous session prefix instead of sending to a literal prefix', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, [
    { sessionKey: 'fa240817-4c3a-4ed5-88ca-000000000001' },
    { sessionKey: 'fa240817-4c3b-4ed5-88ca-000000000002' },
  ]);
  ctx.args = ['fa240817-4c3', 'hello'];

  const lines = await captureLogs(async () => {
    await tryHandleOrchestrationCommand(ctx);
  });

  assert.equal(calls.some((c) => c.name === 'session_send'), false);
  assert.match(lines.join('\n'), /Ambiguous session prefix/);
});

test('/dm refuses an unknown short prefix instead of sending to a literal prefix', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, [{ sessionKey: 'fa240817-4c3a-4ed5-88ca-000000000001' }]);
  ctx.args = ['missing-prefix', 'hello'];

  const lines = await captureLogs(async () => {
    await tryHandleOrchestrationCommand(ctx);
  });

  assert.equal(calls.some((c) => c.name === 'session_send'), false);
  assert.match(lines.join('\n'), /No active or recently-seen session matched prefix/);
});

test('/dm still sends a full-looking unlisted session key literally', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const fullTarget = '11111111-2222-4333-8444-555555555555';
  const ctx = makeContext(calls, []);
  ctx.args = [fullTarget, 'hello'];

  await captureLogs(async () => {
    await tryHandleOrchestrationCommand(ctx);
  });

  const send = calls.find((c) => c.name === 'session_send');
  assert.equal(send?.args.to, fullTarget);
});

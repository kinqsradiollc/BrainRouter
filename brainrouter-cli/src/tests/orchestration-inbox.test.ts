import test from 'node:test';
import assert from 'node:assert/strict';
import { tryHandleOrchestrationCommand } from '../cli/commands/orchestration.js';

function toolResult(payload: unknown) {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function makeContext(
  calls: Array<{ name: string; args: any }>,
  responses: Record<string, unknown>,
) {
  const mcpClient = {
    async callTool(name: string, args: any) {
      calls.push({ name, args });
      if (name in responses) return toolResult(responses[name]);
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  };
  return {
    command: '/inbox',
    args: [] as string[],
    agent: {
      sessionKey: 'chat-session',
      getFederationSessionKey: () => 'self-fed-key',
    },
    mcpClient,
    config: {},
    rl: {},
    repl: {},
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

const ONE_TEXT_MSG = {
  messages: [
    {
      id: 'm-1',
      fromSessionKey: 'peer-abc-123456',
      kind: 'text',
      payload: { text: 'ping from peer' },
      createdAt: new Date().toISOString(),
    },
  ],
};

test('/inbox reads THIS session and consumes (peek:false) by default', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, { session_inbox_read: ONE_TEXT_MSG });
  ctx.args = [];

  let handled = false;
  const lines = await captureLogs(async () => {
    handled = await tryHandleOrchestrationCommand(ctx);
  });

  assert.equal(handled, true);
  const read = calls.find((c) => c.name === 'session_inbox_read');
  assert.ok(read, 'called session_inbox_read');
  assert.equal(read!.args.sessionKey, 'self-fed-key', 'uses the runtime federation key, not a guessed one');
  assert.equal(read!.args.peek, false, 'consumes by default so messages do not pile up');
  const out = lines.join('\n');
  assert.match(out, /ping from peer/);
  assert.match(out, /marked delivered/);
});

test('/inbox --peek inspects without consuming', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, { session_inbox_read: ONE_TEXT_MSG });
  ctx.args = ['--peek'];

  const lines = await captureLogs(async () => {
    await tryHandleOrchestrationCommand(ctx);
  });

  const read = calls.find((c) => c.name === 'session_inbox_read');
  assert.equal(read!.args.peek, true);
  assert.match(lines.join('\n'), /left unread/);
});

test('/inbox --all includes delivered history', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, { session_inbox_read: ONE_TEXT_MSG });
  ctx.args = ['--all'];

  await captureLogs(async () => {
    await tryHandleOrchestrationCommand(ctx);
  });

  const read = calls.find((c) => c.name === 'session_inbox_read');
  assert.equal(read!.args.includeDelivered, true);
});

test('/inbox reports an empty inbox helpfully', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, { session_inbox_read: { messages: [] } });
  ctx.args = [];

  const lines = await captureLogs(async () => {
    await tryHandleOrchestrationCommand(ctx);
  });

  assert.match(lines.join('\n'), /Inbox empty/);
});

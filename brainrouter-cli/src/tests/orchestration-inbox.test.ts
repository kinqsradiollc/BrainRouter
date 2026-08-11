/**
 * CLI inbox command regressions through the production command router. Human
 * approval and decline persist exact terminal state; dismissal stays held and
 * command output never implies safe-boundary application prematurely.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryHandleOrchestrationCommand } from '../cli/commands/orchestration/index.js';
import {
  holdSessionMessage,
  listHeldSessionMessages,
  type LocalSessionMessage,
} from '@kinqs/brainrouter-core/session';

const TEST_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-inbox-command-'));
after(() => fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true }));

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
      workspaceRoot: TEST_WORKSPACE,
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

test('/inbox reads THIS session without bulk-applying peer rows', async () => {
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
  assert.equal(read!.args.peek, true, 'manual inspection must never imply model application');
  assert.deepEqual(read!.args.statuses, ['pending', 'held']);
  const out = lines.join('\n');
  assert.match(out, /ping from peer/);
  assert.match(out, /read-only/);
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
  assert.match(lines.join('\n'), /read-only/);
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
  assert.equal(read!.args.peek, true);
  assert.ok(read!.args.statuses.includes('applied'));
  assert.ok(read!.args.statuses.includes('expired'));
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

function heldMessage(id: string): LocalSessionMessage {
  const now = Date.now();
  return {
    id,
    senderSessionKey: 'peer:sender',
    senderDeviceId: '11111111-1111-4111-8111-111111111111',
    targetSessionKey: 'self-fed-key',
    text: `held content ${id}`,
    createdAt: now - 1,
    receivedAt: now,
    source: 'peer-session',
    trust: 'untrusted-session',
  };
}

test('/inbox decline persists a human decline and sends the exact remote terminal status', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const transitions: Array<{ id: string; status: string; reason?: string }> = [];
  const ctx = makeContext(calls, {});
  const incoming = heldMessage('command-decline');
  holdSessionMessage(TEST_WORKSPACE, incoming, 'Needs human approval.');
  ctx.args = ['decline', incoming.id];
  ctx.repl.federation = {
    transitionInbound: async (id: string, status: string, reason?: string) => {
      transitions.push({ id, status, reason });
      return true;
    },
  };

  const lines = await captureLogs(async () => {
    assert.equal(await tryHandleOrchestrationCommand(ctx), true);
  });

  const terminal = listHeldSessionMessages(TEST_WORKSPACE, 'self-fed-key')
    .find((record) => record.id === incoming.id);
  assert.equal(terminal?.status, 'rejected');
  assert.equal(terminal?.terminalReceiptStatus, 'declined');
  assert.deepEqual(transitions, [{
    id: incoming.id,
    status: 'declined',
    reason: 'Declined by the recipient.',
  }]);
  assert.match(lines.join('\n'), /Declined held peer message/);
});

test('/inbox approve durably approves and queues without presenting a second prompt', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, {});
  const incoming = heldMessage('command-approve');
  holdSessionMessage(TEST_WORKSPACE, incoming, 'Needs human approval.');
  const queued: string[] = [];
  ctx.agent.requestSteer = (_text: string, options: { id: string }) => { queued.push(options.id); };
  ctx.agent.interactionPort = {
    confirm: async () => { throw new Error('explicit command must not re-prompt'); },
    choice: async () => null,
  };
  ctx.args = ['approve', incoming.id];

  const lines = await captureLogs(async () => {
    assert.equal(await tryHandleOrchestrationCommand(ctx), true);
  });

  const approved = listHeldSessionMessages(TEST_WORKSPACE, 'self-fed-key')
    .find((record) => record.id === incoming.id);
  assert.equal(approved?.status, 'approved');
  assert.deepEqual(queued, [incoming.id]);
  assert.match(lines.join('\n'), /queued for the next safe model boundary/);
});

test('/broadcast fallback reads accepted and reports persistence without claiming application', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, { session_send: { accepted: 3, ids: ['a', 'b', 'c'] } });
  ctx.command = '/broadcast';
  ctx.args = ['desktop:*', 'release', 'ready'];

  const lines = await captureLogs(async () => {
    assert.equal(await tryHandleOrchestrationCommand(ctx), true);
  });

  assert.deepEqual(calls.find((call) => call.name === 'session_send')?.args, {
    from: 'self-fed-key',
    to: 'desktop:*',
    kind: 'text',
    payload: { text: 'release ready' },
  });
  const output = lines.join('\n');
  assert.match(output, /persisted for 3 desktop:\* peers/i);
  assert.match(output, /not yet applied/i);
  assert.doesNotMatch(output, /delivered/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { tryHandleBrainCommand } from '../cli/commands/brain.js';

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
    command: '/brain',
    args: [] as string[],
    agent: { sessionKey: 'chat' },
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

const STATUS_PAYLOAD = {
  agents: [
    {
      id: 'cognitive_extractor',
      description: 'x',
      modelClass: 'extraction',
      lastJobStatus: 'done',
      lastJobCompletedAt: new Date().toISOString(),
      successRate24h: 0.95,
      pendingJobs: 0,
    },
    {
      id: 'memory_deduper',
      description: 'x',
      modelClass: 'judge',
      lastJobStatus: 'idle',
      lastJobCompletedAt: null,
      successRate24h: null,
      pendingJobs: 2,
    },
  ],
};

test('/brain (no args) renders the agent status table', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, { memory_agent_status: STATUS_PAYLOAD });
  ctx.args = [];

  let handled = false;
  const lines = await captureLogs(async () => {
    handled = await tryHandleBrainCommand(ctx);
  });

  assert.equal(handled, true);
  assert.equal(calls[0].name, 'memory_agent_status');
  const out = lines.join('\n');
  assert.match(out, /cognitive_extractor/);
  assert.match(out, /memory_deduper/);
  assert.match(out, /2 pending/);
});

test('/brain agents is the same as /brain', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, { memory_agent_status: STATUS_PAYLOAD });
  ctx.args = ['agents'];
  await captureLogs(async () => {
    await tryHandleBrainCommand(ctx);
  });
  assert.equal(calls[0].name, 'memory_agent_status');
});

test('/brain run <id> enqueues via memory_agent_run', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, {
    memory_agent_run: { jobId: 'job-1', status: 'pending', deduped: false },
  });
  ctx.args = ['run', 'identity_distiller'];

  const lines = await captureLogs(async () => {
    await tryHandleBrainCommand(ctx);
  });
  const run = calls.find((c) => c.name === 'memory_agent_run');
  assert.ok(run);
  assert.equal(run!.args.agentId, 'identity_distiller');
  assert.match(lines.join('\n'), /Queued identity_distiller → job job-1/);
});

test('/brain run with no agentId shows usage and does not call the tool', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, {});
  ctx.args = ['run'];
  const lines = await captureLogs(async () => {
    await tryHandleBrainCommand(ctx);
  });
  assert.equal(calls.length, 0);
  assert.match(lines.join('\n'), /Usage: \/brain run/);
});

test('/brain retry <jobId> calls memory_job_retry', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, { memory_job_retry: { status: 'pending' } });
  ctx.args = ['retry', 'job-9'];
  const lines = await captureLogs(async () => {
    await tryHandleBrainCommand(ctx);
  });
  const retry = calls.find((c) => c.name === 'memory_job_retry');
  assert.equal(retry!.args.jobId, 'job-9');
  assert.match(lines.join('\n'), /Job job-9 → pending/);
});

test('/brain does not handle other commands', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, {});
  ctx.command = '/dm';
  const handled = await tryHandleBrainCommand(ctx);
  assert.equal(handled, false);
});

test('/brain surfaces a tool error gracefully', async () => {
  const calls: Array<{ name: string; args: any }> = [];
  const ctx = makeContext(calls, {}); // memory_agent_status not registered → isError
  ctx.args = ['agents'];
  const lines = await captureLogs(async () => {
    await tryHandleBrainCommand(ctx);
  });
  assert.match(lines.join('\n'), /\/brain agents failed/);
});

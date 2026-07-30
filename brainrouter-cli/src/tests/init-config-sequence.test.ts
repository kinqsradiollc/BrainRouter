import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryHandleInitCommand } from '../cli/commands/init/index.js';
import type { CommandContext } from '../cli/commands/_context.js';

function context(): {
  ctx: CommandContext;
  models: string[];
  refreshes: { count: number };
} {
  const models: string[] = [];
  const refreshes = { count: 0 };
  return {
    models,
    refreshes,
    ctx: {
      command: '/init',
      args: ['config'],
      agent: {
        workspaceRoot: '/workspace',
        setModel: (model: string) => { models.push(model); },
      } as never,
      repl: {
        refreshPromptForMode: () => { refreshes.count += 1; },
      } as never,
    } as unknown as CommandContext,
  };
}

test('/init config never starts workspace setup after a global abort', async () => {
  const { ctx, models, refreshes } = context();
  const calls: unknown[] = [];
  assert.equal(await tryHandleInitCommand(ctx, {
    runSequence: async (options) => {
      calls.push(options);
      return {
        status: 'global-aborted',
        global: 'aborted',
        workspace: 'not-needed',
        mcpSkipped: false,
      };
    },
  }), true);
  assert.deepEqual(calls, [{ workspaceRoot: '/workspace', global: 'always' }]);
  assert.deepEqual(models, []);
  assert.equal(refreshes.count, 1);
});

test('/init config applies the committed model after the ordered sequence', async () => {
  const { ctx, models, refreshes } = context();
  assert.equal(await tryHandleInitCommand(ctx, {
    runSequence: async () => ({
      status: 'ready',
      global: 'committed',
      workspace: 'committed',
      mcpSkipped: true,
      config: { llm: { provider: 'openai', model: 'gpt-test', apiKey: '', endpoint: 'https://example.invalid' } } as never,
    }),
  }), true);
  assert.deepEqual(models, ['gpt-test']);
  assert.equal(refreshes.count, 1);
});

test('/init config keeps a committed global setup active when workspace setup fails', async () => {
  const { ctx, refreshes } = context();
  const originalError = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
  try {
    assert.equal(await tryHandleInitCommand(ctx, {
      runSequence: async () => ({
        status: 'ready',
        global: 'committed',
        workspace: 'failed',
        workspaceError: 'read-only workspace: OPENAI_API_KEY=sk-do-not-print',
        mcpSkipped: false,
      }),
    }), true);
  } finally {
    console.error = originalError;
  }
  assert.ok(messages.some((message) => message.includes('Global setup is active')));
  assert.equal(messages.some((message) => message.includes('sk-do-not-print')), false);
  assert.ok(messages.some((message) => message.includes('OPENAI_API_KEY=[REDACTED]')));
  assert.equal(refreshes.count, 1);
});

test('/init scan delegates to the bounded reviewed scan flow', async () => {
  const { ctx } = context();
  ctx.args = ['scan'];
  const roots: string[] = [];
  assert.equal(await tryHandleInitCommand(ctx, {
    runSequence: async () => { throw new Error('unexpected sequence'); },
    runScan: async (root) => { roots.push(root); },
  }), true);
  assert.deepEqual(roots, ['/workspace']);
});

test('/init agent delegates with the active session model and plain-language description', async () => {
  const { ctx } = context();
  const llm = {
    provider: 'openai',
    model: 'managed-model',
    apiKey: 'session-secret',
    endpoint: 'https://example.invalid',
  };
  ctx.args = ['agent', 'Build', 'a', 'responsive', 'customer', 'portal'];
  (ctx.agent as any).getLlmConfig = () => llm;
  const calls: unknown[] = [];
  assert.equal(await tryHandleInitCommand(ctx, {
    runSequence: async () => { throw new Error('unexpected sequence'); },
    runAgent: async (...args) => { calls.push(args); },
  }), true);
  assert.deepEqual(calls, [[
    '/workspace',
    llm,
    'Build a responsive customer portal',
  ]]);
});

test('/init agent supports repository-only proposals when no description is supplied', async () => {
  const { ctx } = context();
  const llm = {
    provider: 'openai',
    model: 'managed-model',
    apiKey: '',
    endpoint: 'https://example.invalid',
  };
  ctx.args = ['agent'];
  (ctx.agent as any).getLlmConfig = () => llm;
  const calls: unknown[] = [];
  assert.equal(await tryHandleInitCommand(ctx, {
    runSequence: async () => { throw new Error('unexpected sequence'); },
    runAgent: async (...args) => { calls.push(args); },
  }), true);
  assert.deepEqual(calls, [['/workspace', llm, undefined]]);
});

test('/init agent redacts model setup errors before displaying them', async () => {
  const { ctx } = context();
  ctx.args = ['agent'];
  (ctx.agent as any).getLlmConfig = () => ({
    provider: 'openai',
    model: 'managed-model',
    apiKey: '',
    endpoint: 'https://example.invalid',
  });
  const originalError = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
  try {
    assert.equal(await tryHandleInitCommand(ctx, {
      runSequence: async () => { throw new Error('unexpected sequence'); },
      runAgent: async () => { throw new Error('OPENAI_API_KEY=sk-do-not-print'); },
    }), true);
  } finally {
    console.error = originalError;
  }
  assert.equal(messages.some((message) => message.includes('sk-do-not-print')), false);
  assert.ok(messages.some((message) => message.includes('OPENAI_API_KEY=[REDACTED]')));
});

test('/init agentmd remains the distinct instruction-file scaffold', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-init-agentmd-'));
  const { ctx } = context();
  ctx.args = ['agentmd'];
  (ctx.agent as any).workspaceRoot = root;
  let assistedCalls = 0;
  try {
    assert.equal(await tryHandleInitCommand(ctx, {
      runSequence: async () => { throw new Error('unexpected sequence'); },
      runAgent: async () => { assistedCalls += 1; },
    }), true);
    assert.equal(assistedCalls, 0);
    assert.equal(fs.existsSync(path.join(root, 'AGENT.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.brainrouter', 'workspace.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

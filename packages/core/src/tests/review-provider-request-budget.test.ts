import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Agent, type RunTurnCallbacks } from '../agent/agent.js';
import {
  _resetCliKnobsCache,
  setCliKnobOverride,
} from '../config/config.js';
import type { ResolvedRouterCliKnobs } from '../config/configTypes.js';
import { resetRouterPolicyForTests } from '../provider/routing/policy.js';

const directRouter: ResolvedRouterCliKnobs = {
  enabled: false,
  passThrough: true,
  chain: [],
  strategy: 'priority',
  order: [],
  aliases: {},
  cooldownBaseMs: 500,
  cooldownMaxMs: 1_000,
  sessionAffinity: true,
  serve: false,
  serveHost: '127.0.0.1',
  servePort: 8_790,
  serveKey: '',
};

const callbacks = (): RunTurnCallbacks => ({
  onStatusUpdate: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
});

const stubMcp = {
  listTools: async () => ({ tools: [] }),
  callTool: async () => ({ content: [] }),
  close: async () => {},
};

function makeAgent(
  workspaceRoot: string,
  options: { reviewSourceSafety: boolean; models?: string[] },
): Agent {
  return new Agent({ ...stubMcp } as never, {
    provider: 'openai',
    apiKey: 'test-key',
    model: 'primary-model',
    endpoint: 'https://review-budget.invalid/v1',
    ...(options.models ? { models: options.models } : {}),
  }, {
    workspaceRoot,
    launchCwd: workspaceRoot,
    sessionKey: `review:provider-budget:${Math.random()}`,
    silent: true,
    enableRecall: false,
    learningEnabled: false,
    reviewSourceSafety: options.reviewSourceSafety,
    maxModelCallsPerTurn: 1,
    maxLlmReconnectsPerCall: 0,
    accessMode: 'read',
    authorityToolCeiling: { local: [], mcp: [] },
  });
}

async function withWorkspace(run: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-review-provider-budget-'));
  try {
    await run(workspaceRoot);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

test.beforeEach(() => {
  _resetCliKnobsCache();
  resetRouterPolicyForTests();
  setCliKnobOverride({
    providerRequestFormat: { openai: 'chat-completions' },
    recallMode: 'gated',
    disableStream: false,
    fallbackModel: null,
    fallbackModels: [],
    router: directRouter,
  });
});

test.after(() => {
  resetRouterPolicyForTests();
  _resetCliKnobsCache();
});

test('review provider budget blocks the non-streaming request after a failed stream request', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const originalFetch = globalThis.fetch;
    let physicalRequests = 0;
    globalThis.fetch = (async () => {
      physicalRequests += 1;
      return new Response(JSON.stringify({ error: { message: 'stream unavailable' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const agent = makeAgent(workspaceRoot, { reviewSourceSafety: true });
      const streamingCallbacks = callbacks();
      streamingCallbacks.onAssistantDelta = () => {};
      await assert.rejects(
        () => agent.runTurn('review the supplied diff', streamingCallbacks, { preplanned: true }),
        /Review provider-request budget exhausted after 1 physical request/,
      );
      assert.equal(physicalRequests, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('review provider budget blocks a router fallback before its physical request', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const originalFetch = globalThis.fetch;
    const calledModels: string[] = [];
    setCliKnobOverride({
      router: {
        ...directRouter,
        enabled: true,
        chain: ['primary-model', 'router-fallback'],
      },
    });
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calledModels.push(String((JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model));
      return new Response(JSON.stringify({
        error: { message: 'invalid model primary-model', type: 'invalid_request_error' },
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const agent = makeAgent(workspaceRoot, {
        reviewSourceSafety: true,
        models: ['primary-model', 'router-fallback'],
      });
      await assert.rejects(
        () => agent.runTurn('review through the configured route', callbacks(), { preplanned: true }),
        /Review provider-request budget exhausted after 1 physical request/,
      );
      assert.deepEqual(calledModels, ['primary-model']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('review provider budget blocks a model-not-found fallback before its physical request', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const originalFetch = globalThis.fetch;
    const calledModels: string[] = [];
    setCliKnobOverride({
      fallbackModels: ['model-fallback'],
      router: directRouter,
    });
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calledModels.push(String((JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model));
      return new Response(JSON.stringify({
        error: { message: 'model primary-model not found', type: 'invalid_request_error' },
      }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const agent = makeAgent(workspaceRoot, { reviewSourceSafety: true });
      await assert.rejects(
        () => agent.runTurn('review with a model fallback configured', callbacks(), { preplanned: true }),
        /Review provider-request budget exhausted after 1 physical request/,
      );
      assert.deepEqual(calledModels, ['primary-model']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('ordinary Agents retain fallback behavior when maxModelCallsPerTurn is set', async () => {
  await withWorkspace(async (workspaceRoot) => {
    const originalFetch = globalThis.fetch;
    const calledModels: string[] = [];
    setCliKnobOverride({
      fallbackModels: ['model-fallback'],
      router: directRouter,
    });
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const model = String((JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model);
      calledModels.push(model);
      if (model === 'primary-model') {
        return new Response(JSON.stringify({
          error: { message: 'model primary-model not found', type: 'invalid_request_error' },
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'fallback answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const agent = makeAgent(workspaceRoot, { reviewSourceSafety: false });
      const answer = await agent.runTurn(
        'ordinary agent fallback',
        callbacks(),
        { preplanned: true },
      );
      assert.equal(answer, 'fallback answer');
      assert.deepEqual(calledModels, ['primary-model', 'model-fallback']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

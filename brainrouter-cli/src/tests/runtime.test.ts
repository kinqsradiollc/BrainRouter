import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInterval, isLoopRunning, startLoop, stopLoop, getLoopState } from '../runtime/loopRunner.js';
import { resolveSandboxConfig } from '../runtime/sandbox.js';
import { startSpan, traceEnabled } from '../runtime/tracing.js';

test('callOpenAI: rejects malformed LLM responses with a useful error instead of TypeError', async () => {
  // Stub the global fetch with three scenarios that have historically crashed
  // the agent loop with `Cannot read properties of undefined (reading '0')`
  // when the upstream returned HTTP 200 + a non-standard body.
  const { callOpenAI } = await import('../agent/agent.js');
  const realFetch = global.fetch;
  const llmConfig = { provider: 'openai' as const, apiKey: 'test', model: 'gpt-oss-120b', endpoint: 'http://localhost:9999/v1' };

  const cases: Array<{ name: string; body: any; expectMatch: RegExp }> = [
    {
      name: 'error envelope with HTTP 200 (common with OpenRouter upstream failures)',
      body: { error: { message: 'Model "gpt-oss-120b" not found' } },
      expectMatch: /error envelope.*Model "gpt-oss-120b" not found/,
    },
    {
      name: 'missing choices array (some local servers under load)',
      body: { id: 'cmpl-xxx', object: 'chat.completion' },
      expectMatch: /no choices.*gpt-oss-120b/,
    },
    {
      name: 'empty choices array',
      body: { choices: [] },
      expectMatch: /no choices/,
    },
  ];

  try {
    for (const c of cases) {
      global.fetch = (async () => new Response(JSON.stringify(c.body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as any;
      await assert.rejects(
        () => callOpenAI(llmConfig, [], []),
        (err: any) => c.expectMatch.test(err.message ?? ''),
        `case "${c.name}" should reject with descriptive error, not TypeError`,
      );
    }
  } finally {
    global.fetch = realFetch;
  }
});

test('llmSemaphore: caps concurrent acquires and queues the rest', async () => {
  const { acquireLLMSlot, getLLMSemaphoreState, resetLLMSemaphoreForTests } =
    await import('../runtime/llmSemaphore.js');
  // Force a known cap of 2 for this test.
  process.env.BRAINROUTER_LLM_MAX_CONCURRENT = '2';
  resetLLMSemaphoreForTests();
  try {
    const r1 = await acquireLLMSlot();
    const r2 = await acquireLLMSlot();
    assert.equal(getLLMSemaphoreState().inFlight, 2);

    // Third caller must queue, not resolve until something releases.
    let r3Resolved = false;
    const r3Promise = acquireLLMSlot().then((release) => {
      r3Resolved = true;
      return release;
    });
    // Yield the event loop so the queued promise has a chance to resolve
    // (it should NOT, because in-flight is still at cap).
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(r3Resolved, false, 'third acquire must wait for a release');
    assert.equal(getLLMSemaphoreState().queued, 1);

    // Releasing one slot should let the queued waiter proceed.
    r1();
    const r3 = await r3Promise;
    assert.equal(r3Resolved, true);
    assert.equal(getLLMSemaphoreState().inFlight, 2);

    // Double-release should be a no-op (release idempotency).
    r1();
    assert.equal(getLLMSemaphoreState().inFlight, 2);

    r2();
    r3();
    assert.equal(getLLMSemaphoreState().inFlight, 0);
  } finally {
    delete process.env.BRAINROUTER_LLM_MAX_CONCURRENT;
    resetLLMSemaphoreForTests();
  }
});

test('loopRunner: parseInterval accepts s/m/h/ms', () => {
  assert.equal(parseInterval('5s'), 5_000);
  assert.equal(parseInterval('2m'), 120_000);
  assert.equal(parseInterval('1h'), 3_600_000);
  assert.equal(parseInterval('500ms'), 500);
  assert.equal(parseInterval('notatime'), undefined);
});

test('loopRunner: only one loop runs at a time and stop releases the slot', async () => {
  assert.equal(isLoopRunning(), false);
  const first = startLoop('one', 60_000, async () => {});
  assert.equal(first.started, true);
  const second = startLoop('two', 60_000, async () => {});
  assert.equal(second.started, false);
  assert.match(second.reason ?? '', /already running/);
  assert.equal(getLoopState()?.prompt, 'one');
  assert.equal(stopLoop(), true);
  assert.equal(isLoopRunning(), false);
});

test('resolveSandboxConfig reflects env toggles', () => {
  const prevEnabled = process.env.BRAINROUTER_SANDBOX;
  const prevReads = process.env.BRAINROUTER_SANDBOX_READ_PATHS;
  try {
    process.env.BRAINROUTER_SANDBOX = 'on';
    process.env.BRAINROUTER_SANDBOX_READ_PATHS = '/usr/local:/opt';
    const cfg = resolveSandboxConfig('/tmp/x');
    assert.equal(cfg.enabled, true);
    assert.deepEqual(cfg.readPaths, ['/usr/local', '/opt']);
    assert.equal(cfg.allowNetwork, false);
  } finally {
    if (prevEnabled === undefined) delete process.env.BRAINROUTER_SANDBOX; else process.env.BRAINROUTER_SANDBOX = prevEnabled;
    if (prevReads === undefined) delete process.env.BRAINROUTER_SANDBOX_READ_PATHS; else process.env.BRAINROUTER_SANDBOX_READ_PATHS = prevReads;
  }
});

test('tracing.startSpan is a no-op when BRAINROUTER_TRACE_LOG is unset', () => {
  const prev = process.env.BRAINROUTER_TRACE_LOG;
  delete process.env.BRAINROUTER_TRACE_LOG;
  try {
    assert.equal(traceEnabled(), false);
    const span = startSpan('test', { foo: 'bar' });
    span.end({ done: true });
    // No throw, no file created — that's the test.
    assert.equal(typeof span.end, 'function');
  } finally {
    if (prev !== undefined) process.env.BRAINROUTER_TRACE_LOG = prev;
  }
});

test('compactor: renderCompactSystemMessage tags the summary clearly', async () => {
  const { renderCompactSystemMessage } = await import('../prompt/compactor.js');
  const rendered = renderCompactSystemMessage('# Goals\n- Ship feature X');
  assert.match(rendered, /Compacted conversation summary/);
  assert.match(rendered, /Ship feature X/);
});

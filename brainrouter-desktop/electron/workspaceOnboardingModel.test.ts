import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ONBOARDING_PROPOSAL_MAX_RAW_BYTES,
  WORKSPACE_ONBOARDING_PROPOSAL_TOOL,
  type WorkspaceOnboardingModelRequest,
} from '@kinqs/brainrouter-core/workspace';
import {
  completeWorkspaceOnboardingWithModel,
  type WorkspaceOnboardingModelCall,
} from './workspaceOnboardingModel.js';

function request(maxOutputBytes = 1024): WorkspaceOnboardingModelRequest {
  return {
    system: 'system prompt',
    user: 'repository summary',
    tool: WORKSPACE_ONBOARDING_PROPOSAL_TOOL,
    toolChoice: {
      type: 'function',
      function: { name: WORKSPACE_ONBOARDING_PROPOSAL_TOOL.name },
    },
    maxOutputBytes,
    signal: new AbortController().signal,
  };
}

const llm = { provider: 'openai', model: 'test-model', apiKey: 'test-key' };

test('uses the active model with a forced tool and bounded non-retrying transport', async () => {
  const req = request();
  let observed: Parameters<WorkspaceOnboardingModelCall> | undefined;
  const raw = await completeWorkspaceOnboardingWithModel(llm, req, async (...args) => {
    observed = args;
    return {
      content: 'ignored fallback',
      toolCalls: [
        { function: { name: 'other_tool', arguments: '{"ignored":true}' } },
        { function: { name: req.tool.name, arguments: '{"profile":"engineering"}' } },
      ],
    };
  });

  assert.equal(raw, '{"profile":"engineering"}');
  assert.ok(observed);
  assert.equal(observed[0], llm);
  assert.deepEqual(observed[1], [
    { role: 'system', content: req.system },
    { role: 'user', content: req.user },
  ]);
  assert.deepEqual(observed[2], [{
    name: req.tool.name,
    description: req.tool.description,
    inputSchema: req.tool.parameters,
  }]);
  assert.equal(observed[3].tool_choice, req.toolChoice);
  assert.equal(observed[3].signal, req.signal);
  assert.equal(observed[3].allowCompatibilityRetry, false);
  assert.equal(observed[3].maxResponseBytes, req.maxOutputBytes + 64 * 1024);
});

test('falls back to response content and serializes structured tool arguments', async () => {
  const content = await completeWorkspaceOnboardingWithModel(llm, request(), async () => ({
    content: '{"profile":"study"}',
  }));
  assert.equal(content, '{"profile":"study"}');

  const structured = await completeWorkspaceOnboardingWithModel(llm, request(), async () => ({
    toolCalls: [{
      function: {
        name: WORKSPACE_ONBOARDING_PROPOSAL_TOOL.name,
        arguments: { profile: 'writing' },
      },
    }],
  }));
  assert.equal(structured, '{"profile":"writing"}');
});

test('rejects invalid limits before calling the provider', async () => {
  let calls = 0;
  const invoke = async () => {
    calls += 1;
    return { content: '{}' };
  };

  await assert.rejects(
    completeWorkspaceOnboardingWithModel(llm, request(0), invoke),
    /Invalid workspace onboarding model-output limit/,
  );
  await assert.rejects(
    completeWorkspaceOnboardingWithModel(
      llm,
      request(ONBOARDING_PROPOSAL_MAX_RAW_BYTES + 1),
      invoke,
    ),
    /Invalid workspace onboarding model-output limit/,
  );
  assert.equal(calls, 0);
});

test('rejects extracted output above the core proposal ceiling', async () => {
  await assert.rejects(
    completeWorkspaceOnboardingWithModel(llm, request(4), async () => ({ content: '12345' })),
    /model output exceeded the byte limit/,
  );
});

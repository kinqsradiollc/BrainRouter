import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeOrchestrationStrategyWithModel,
  type OrchestrationStrategyModelCall,
} from '../agent/adapters/orchestrationStrategyModel.js';
import {
  ADAPTIVE_STRATEGY_MAX_OUTPUT_BYTES,
  type AdaptiveStrategySelectionModelRequest,
} from '../orchestration/profiles/adaptiveStrategySelectionModel.js';
import type { LLMConfig } from '../config/configTypes.js';

const llm: LLMConfig = {
  provider: 'openai',
  model: 'managed-test',
  endpoint: 'https://example.invalid/v1',
  apiKey: 'test',
};

function request(
  overrides: Partial<AdaptiveStrategySelectionModelRequest> = {},
): AdaptiveStrategySelectionModelRequest {
  return {
    system: 'system',
    user: 'user',
    tool: {
      name: 'select_orchestration_strategy',
      description: 'select',
      parameters: { type: 'object' },
    },
    toolChoice: {
      type: 'function',
      function: { name: 'select_orchestration_strategy' },
    },
    maxOutputBytes: ADAPTIVE_STRATEGY_MAX_OUTPUT_BYTES,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test('P23-7 model adapter enforces one low-effort forced-tool request', async () => {
  let seenOptions: Parameters<OrchestrationStrategyModelCall>[3] | undefined;
  const raw = await completeOrchestrationStrategyWithModel(
    llm,
    request(),
    async (_config, messages, tools, options) => {
      assert.deepEqual(messages, [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'user' },
      ]);
      assert.equal(tools[0]?.name, 'select_orchestration_strategy');
      seenOptions = options;
      return {
        toolCalls: [{
          function: {
            name: 'select_orchestration_strategy',
            arguments: {
              strategyId: 'delivery',
              enabledStageIds: ['implement', 'deliver'],
              rationale: 'bounded',
            },
          },
        }],
      };
    },
  );

  assert.deepEqual(JSON.parse(raw), {
    strategyId: 'delivery',
    enabledStageIds: ['implement', 'deliver'],
    rationale: 'bounded',
  });
  assert.equal(seenOptions?.effort, 'low');
  assert.equal(seenOptions?.allowCompatibilityRetry, false);
  assert.deepEqual(seenOptions?.tool_choice, request().toolChoice);
  assert.ok((seenOptions?.maxResponseBytes ?? 0) > ADAPTIVE_STRATEGY_MAX_OUTPUT_BYTES);
});

test('P23-7 model adapter rejects invalid request and response ceilings', async () => {
  await assert.rejects(
    completeOrchestrationStrategyWithModel(
      llm,
      request({ maxOutputBytes: ADAPTIVE_STRATEGY_MAX_OUTPUT_BYTES + 1 }),
      async () => ({ content: '{}' }),
    ),
    /Invalid orchestration strategy model-output limit/,
  );

  await assert.rejects(
    completeOrchestrationStrategyWithModel(
      llm,
      request({ maxOutputBytes: 8 }),
      async () => ({ content: 'x'.repeat(9) }),
    ),
    /exceeded the byte limit/,
  );
});

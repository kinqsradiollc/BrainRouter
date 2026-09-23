import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeToolBatch,
  publishToolBatch,
  repairOrphanToolResults,
  type BatchToolCall,
  type BatchToolResult,
} from '../agent/runtime/toolBatchExecutionPhase.js';

function toolCall(id: string): BatchToolCall {
  return {
    id,
    type: 'function',
    function: { name: `tool_${id}`, arguments: '{}' },
  };
}

function result(id: string, systemMsg?: unknown): BatchToolResult {
  return {
    toolMsg: {
      role: 'tool',
      tool_call_id: id,
      name: `tool_${id}`,
      content: `result_${id}`,
    },
    fullResultText: `full_${id}`,
    systemMsg,
  };
}

test('executeToolBatch overlaps safe calls while retaining original result order', async () => {
  const calls = [toolCall('a'), toolCall('b'), toolCall('c')];
  let safeStarted = 0;
  let releaseSafe: (() => void) | undefined;
  const safeGate = new Promise<void>((resolve) => {
    releaseSafe = resolve;
  });
  const starts: string[] = [];

  const results = await executeToolBatch({
    toolCalls: calls,
    normalizedNames: ['tool_a', 'tool_b', 'tool_c'],
    parallelSafe: [true, true, false],
    executeOne: async (call) => {
      starts.push(call.id);
      if (call.id !== 'c') {
        safeStarted += 1;
        if (safeStarted === 2) releaseSafe?.();
        await safeGate;
      }
      return result(call.id);
    },
    interrupted: () => false,
    onInterrupted: () => assert.fail('batch was not interrupted'),
  });

  assert.deepEqual(starts, ['a', 'b', 'c']);
  assert.deepEqual(results.map((entry) => entry.toolMsg.tool_call_id), ['a', 'b', 'c']);
});

test('executeToolBatch fills every undispatched call after interruption', async () => {
  const calls = [toolCall('a'), toolCall('b'), toolCall('c')];
  let interrupted = false;
  const skipped: string[] = [];

  const results = await executeToolBatch({
    toolCalls: calls,
    normalizedNames: ['tool_a', 'tool_b', 'tool_c'],
    parallelSafe: [false, false, false],
    executeOne: async (call) => {
      interrupted = true;
      return result(call.id);
    },
    interrupted: () => interrupted,
    onInterrupted: (_name, call) => skipped.push(call.id),
  });

  assert.deepEqual(skipped, ['b', 'c']);
  assert.deepEqual(results.map((entry) => entry.toolMsg.tool_call_id), ['a', 'b', 'c']);
  assert.match(results[1].toolMsg.content, /interrupted by user/);
  assert.match(results[2].toolMsg.content, /interrupted by user/);
});

test('publishToolBatch publishes tool results before deferred system messages', () => {
  const published: string[] = [];
  publishToolBatch({
    results: [result('a', 'system_a'), result('b', 'system_b')],
    publishToolResult: (message, fullResultText) => {
      published.push(`${message.tool_call_id}:${fullResultText}`);
    },
    publishSystemMessage: (message) => published.push(String(message)),
    publishImageMessage: (message) => published.push(String(message)),
  });

  assert.deepEqual(published, ['a:full_a', 'b:full_b', 'system_a', 'system_b']);
});

test('publishToolBatch flushes image messages LAST — after tool results and system messages', () => {
  const published: string[] = [];
  publishToolBatch({
    results: [
      { ...result('a', 'system_a'), imageMsg: 'image_a' },
      result('b'),
    ],
    publishToolResult: (message) => published.push(`tool:${message.tool_call_id}`),
    publishSystemMessage: (message) => published.push(`sys:${String(message)}`),
    publishImageMessage: (message) => published.push(`img:${String(message)}`),
  });
  // Every tool result precedes any system message, and the image rides last so
  // the assistant tool_calls are immediately followed only by tool results.
  assert.deepEqual(published, ['tool:a', 'tool:b', 'sys:system_a', 'img:image_a']);
});

test('repairOrphanToolResults publishes a paired error for every missing id', () => {
  const syntheticIds: string[] = [];
  repairOrphanToolResults({
    toolCalls: [toolCall('a'), toolCall('b')],
    results: [result('a')],
    publishSyntheticResult: (message) => syntheticIds.push(message.tool_call_id),
  });

  assert.deepEqual(syntheticIds, ['b']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { emitAgentRouteFeedback } from '../orchestration/memoryEvents.js';

/**
 * MAS-P2-M6 — `agent_route_feedback` emitter tests.
 *
 * The emitter has three contracts:
 *
 *   1. Best-effort: never throws, no matter what the brain returns.
 *   2. Carries the structured payload (`task`, `chosenAgentId`,
 *      `parentAgentId`, `ownership`, `outcome`, `durationMs`,
 *      `tokenCost`) as the assistant content so the brain extractor
 *      can parse it once it learns the kind.
 *   3. Gracefully no-ops when MCP is offline OR the brain doesn't
 *      expose `memory_capture_turn` (pre-extractor brains).
 */

function captureClient(opts: {
  listTools?: Array<{ name: string }>;
  captureResult?: any;
  captureError?: boolean;
}) {
  const calls: Array<{ name: string; args: any }> = [];
  const client = {
    async listTools() {
      return { tools: opts.listTools ?? [{ name: 'memory_capture_turn' }] };
    },
    async callTool(name: string, args: any) {
      calls.push({ name, args });
      if (opts.captureError) throw new Error('mcp blew up');
      if (name === 'memory_capture_turn') {
        return opts.captureResult ?? {
          isError: false,
          content: [{ type: 'text', text: JSON.stringify({ recordId: 'rec-emit-1' }) }],
        };
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown' }] };
    },
  } as any;
  return { client, calls };
}

test('emit: writes a memory_capture_turn call with the structured payload', async () => {
  const { client, calls } = captureClient({});
  const id = await emitAgentRouteFeedback(
    { mcpClient: client, sessionKey: 'sk-parent' },
    {
      task: 'explore the federation Stage 2 active_sessions table',
      chosenAgentId: 'explorer',
      parentAgentId: 'chat-root',
      ownership: 'brainrouter/src/memory/store/**',
      outcome: 'success',
      durationMs: 12_345,
      tokenCost: 8_192,
    },
  );

  assert.equal(id, 'rec-emit-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'memory_capture_turn');
  assert.equal(calls[0].args.sessionKey, 'sk-parent');
  assert.equal(calls[0].args.messages.length, 2);

  // The assistant message carries the structured payload as JSON so a
  // future brain-side extractor change can parse it without further
  // schema migration.
  const assistantContent = calls[0].args.messages[1].content;
  const parsed = JSON.parse(assistantContent);
  assert.equal(parsed.task, 'explore the federation Stage 2 active_sessions table');
  assert.equal(parsed.chosenAgentId, 'explorer');
  assert.equal(parsed.parentAgentId, 'chat-root');
  assert.equal(parsed.ownership, 'brainrouter/src/memory/store/**');
  assert.equal(parsed.outcome, 'success');
  assert.equal(parsed.durationMs, 12_345);
  assert.equal(parsed.tokenCost, 8_192);

  // The user message tags the kind in plain text so a grep / SQL probe
  // can find these rows even before the extractor knows the type.
  const userContent = calls[0].args.messages[0].content;
  assert.match(userContent, /agent_route_feedback/);
  assert.match(userContent, /explorer/);
});

test('emit: long task is truncated to 240 chars before capture (no payload bloat)', async () => {
  const { client, calls } = captureClient({});
  const longTask = 'a '.repeat(500);
  await emitAgentRouteFeedback(
    { mcpClient: client, sessionKey: 'sk' },
    { task: longTask, chosenAgentId: 'worker', outcome: 'success' },
  );
  const parsed = JSON.parse(calls[0].args.messages[1].content);
  assert.ok(parsed.task.length <= 240);
  assert.ok(parsed.task.endsWith('…'));
});

test('emit: returns null when MCP client is missing (offline mode)', async () => {
  const id = await emitAgentRouteFeedback(
    { mcpClient: undefined, sessionKey: 'sk' },
    { task: 'x', chosenAgentId: 'worker', outcome: 'success' },
  );
  assert.equal(id, null);
});

test('emit: returns null when the brain does not expose memory_capture_turn', async () => {
  const { client, calls } = captureClient({ listTools: [{ name: 'memory_recall' }] });
  const id = await emitAgentRouteFeedback(
    { mcpClient: client, sessionKey: 'sk' },
    { task: 'x', chosenAgentId: 'worker', outcome: 'success' },
  );
  assert.equal(id, null);
  // Must not call memory_capture_turn when the tool isn't listed.
  assert.equal(calls.filter((c) => c.name === 'memory_capture_turn').length, 0);
});

test('emit: swallows MCP errors (never throws)', async () => {
  const { client } = captureClient({ captureError: true });
  const id = await emitAgentRouteFeedback(
    { mcpClient: client, sessionKey: 'sk' },
    { task: 'x', chosenAgentId: 'worker', outcome: 'failure' },
  );
  assert.equal(id, null);
});

test('emit: returns null when the brain responds with isError:true', async () => {
  const { client } = captureClient({
    captureResult: { isError: true, content: [{ type: 'text', text: 'nope' }] },
  });
  const id = await emitAgentRouteFeedback(
    { mcpClient: client, sessionKey: 'sk' },
    { task: 'x', chosenAgentId: 'worker', outcome: 'success' },
  );
  assert.equal(id, null);
});

test('emit: returns null when the brain returns a non-parseable response', async () => {
  const { client } = captureClient({
    captureResult: {
      isError: false,
      content: [{ type: 'text', text: 'not json — sensoryRecordId: rec-x' }],
    },
  });
  const id = await emitAgentRouteFeedback(
    { mcpClient: client, sessionKey: 'sk' },
    { task: 'x', chosenAgentId: 'worker', outcome: 'success' },
  );
  // Caller can't trust a non-JSON shape; the emitter declines to invent an id.
  assert.equal(id, null);
});

test('emit: passes the toolNames override and skips listTools when supplied', async () => {
  const { client, calls } = captureClient({});
  await emitAgentRouteFeedback(
    {
      mcpClient: client,
      sessionKey: 'sk',
      toolNames: new Set(['memory_capture_turn']),
    },
    { task: 'x', chosenAgentId: 'worker', outcome: 'success' },
  );
  // listTools must not be in the call log when the override is provided.
  assert.ok(calls.every((c) => c.name !== 'listTools'));
  assert.equal(calls.filter((c) => c.name === 'memory_capture_turn').length, 1);
});

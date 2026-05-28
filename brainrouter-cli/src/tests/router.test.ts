import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTask } from '../orchestration/router.js';

/**
 * MAS-P2-M2 + M4 — `route_task` direct-first policy tests.
 *
 * Covers:
 *
 *   1. Tier classification — each tier hits a representative prompt.
 *   2. Offline path — no MCP, no memory hop, confidence capped at 0.6.
 *   3. Memory path — when `memory_recall` is available and surfaces
 *      `agent_route_feedback` records, confidence is boosted and the
 *      record ids appear in `memoryEvidence`.
 *   4. Graceful degradation — MCP errors, missing records, or a
 *      hostile memory_recall response all keep the regex baseline
 *      working rather than throwing.
 */

function makeStubClient(opts: {
  recall?: any | (() => any | Promise<any>);
  recallError?: boolean;
}) {
  return {
    async listTools() {
      return { tools: [{ name: 'memory_recall' }] };
    },
    async callTool(name: string, _args: any) {
      if (name !== 'memory_recall') {
        return { isError: true, content: [{ type: 'text', text: 'unexpected' }] };
      }
      if (opts.recallError) {
        return { isError: true, content: [{ type: 'text', text: 'boom' }] };
      }
      const payload = typeof opts.recall === 'function' ? await opts.recall() : opts.recall;
      return {
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(payload ?? { recalledCognitiveMemories: [] }) }],
      };
    },
  } as any;
}

test('tier classification: greeting → answer-direct', async () => {
  const res = await routeTask({ task: 'hi', skipMemory: true });
  assert.equal(res.tier, 'answer-direct');
  assert.equal(res.recommendedTool, null);
  assert.equal(res.agentId, null);
});

test('tier classification: short factual q with no code referent → answer-direct', async () => {
  const res = await routeTask({ task: 'what does CSP stand for?', skipMemory: true });
  assert.equal(res.tier, 'answer-direct');
});

test('tier classification: specific file path + line ref → direct-tool (read_file)', async () => {
  const res = await routeTask({ task: 'show me src/agent/agent.ts:1144', skipMemory: true });
  assert.equal(res.tier, 'direct-tool');
  assert.equal(res.recommendedTool, 'read_file');
});

test('tier classification: named class/function → direct-tool (grep_search)', async () => {
  const res = await routeTask({ task: 'find class Agent', skipMemory: true });
  assert.equal(res.tier, 'direct-tool');
  assert.equal(res.recommendedTool, 'grep_search');
});

test('tier classification: shell verb → direct-tool (run_command)', async () => {
  const res = await routeTask({ task: 'run npm test', skipMemory: true });
  assert.equal(res.tier, 'direct-tool');
  assert.equal(res.recommendedTool, 'run_command');
});

test('tier classification: investigation verbs → spawn-inline (explorer)', async () => {
  const res = await routeTask({ task: 'investigate where the recall pipeline lives in the codebase', skipMemory: true });
  assert.equal(res.tier, 'spawn-inline');
  assert.equal(res.agentId, 'explorer');
  assert.equal(res.recommendedTool, 'delegate_explorer');
});

test('tier classification: design verbs → spawn-inline (architect)', async () => {
  const res = await routeTask({ task: 'propose two architecture alternatives for the session inbox', skipMemory: true });
  assert.equal(res.tier, 'spawn-inline');
  assert.equal(res.agentId, 'architect');
});

test('tier classification: review verbs → spawn-inline (reviewer)', async () => {
  const res = await routeTask({ task: 'review the change in src/orchestration for race conditions', skipMemory: true });
  assert.equal(res.tier, 'spawn-inline');
  assert.equal(res.agentId, 'reviewer');
});

test('tier classification: verify verbs → spawn-inline (verifier)', async () => {
  const res = await routeTask({ task: 'verify typecheck and lint pass after the rename', skipMemory: true });
  assert.equal(res.tier, 'spawn-inline');
  assert.equal(res.agentId, 'verifier');
});

test('tier classification: implementation prompt with no investigation verbs → spawn-inline (worker)', async () => {
  const res = await routeTask({ task: 'implement the hero component as a plain HTML module', skipMemory: true });
  assert.equal(res.tier, 'spawn-inline');
  assert.equal(res.agentId, 'worker');
});

test('tier classification: long-running cue → spawn-worker', async () => {
  const res = await routeTask({
    task: 'while I keep working, run a long-running benchmark on the recall pipeline',
    skipMemory: true,
  });
  assert.equal(res.tier, 'spawn-worker');
});

test('offline path: confidence capped at 0.6 + memoryEvidence empty + reason notes the gap', async () => {
  const res = await routeTask({ task: 'review the diff in src/foo.ts', skipMemory: true });
  assert.ok(res.confidence <= 0.6 + 1e-9);
  assert.deepEqual(res.memoryEvidence, []);
  assert.match(res.reason, /no memory hop/i);
});

test('memory hop: matching records boost confidence + populate memoryEvidence', async () => {
  const client = makeStubClient({
    recall: {
      recalledCognitiveMemories: [
        { recordId: 'rec-a', type: 'agent_route_feedback', content: 'past explorer success' },
        { recordId: 'rec-b', type: 'agent_route_feedback', content: 'past explorer success' },
      ],
    },
  });
  const res = await routeTask({
    task: 'explore the federation Stage 2 active_sessions table',
    mcpClient: client,
    mcpToolNames: new Set(['memory_recall']),
  });
  assert.equal(res.tier, 'spawn-inline');
  assert.equal(res.agentId, 'explorer');
  assert.deepEqual(res.memoryEvidence, ['rec-a', 'rec-b']);
  assert.ok(res.confidence > 0.85, `expected boost beyond baseline, got ${res.confidence}`);
});

test('memory hop: no records returned → baseline confidence, evidence empty', async () => {
  const client = makeStubClient({ recall: { recalledCognitiveMemories: [] } });
  const res = await routeTask({
    task: 'explore the federation Stage 2 active_sessions table',
    mcpClient: client,
    mcpToolNames: new Set(['memory_recall']),
  });
  assert.deepEqual(res.memoryEvidence, []);
  assert.ok(res.confidence >= 0.8, `confidence should NOT collapse to offline cap when memory hop succeeded but found nothing; got ${res.confidence}`);
});

test('memory hop: brain error is swallowed, baseline returned', async () => {
  const client = makeStubClient({ recallError: true });
  const res = await routeTask({
    task: 'explore the federation Stage 2 active_sessions table',
    mcpClient: client,
    mcpToolNames: new Set(['memory_recall']),
  });
  assert.deepEqual(res.memoryEvidence, []);
  assert.equal(res.tier, 'spawn-inline');
});

test('rejects empty task', async () => {
  await assert.rejects(() => routeTask({ task: '' }), /requires a non-empty/);
});

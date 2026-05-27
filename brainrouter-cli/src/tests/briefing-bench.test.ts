import test from 'node:test';
import assert from 'node:assert/strict';
import { decideMemoryBriefing } from '../memory/briefingTriggers.js';
import { compactToolOutput } from '../prompt/toolCompaction.js';
import { buildMemoryBriefing } from '../memory/briefing.js';

/**
 * Stub MCP client. Each scenario configures which tools "exist" via the
 * mcpTools list passed to buildMemoryBriefing, and which canned responses
 * each tool returns here. We never go over the network.
 */
function makeStubClient(canned: Record<string, any>) {
  return {
    async callTool(name: string, _args: Record<string, unknown>) {
      const payload = canned[name];
      if (payload === undefined) {
        return { isError: true, content: [{ type: 'text', text: 'tool not configured' }] };
      }
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return { isError: false, content: [{ type: 'text', text }] };
    },
  } as any;
}

const base = {
  recallMode: 'gated' as const,
  recallHasFiredThisSession: true,
  postCompaction: false,
  hasActiveGoal: false,
  turnsSinceLastFullBriefing: 1,
};

test('briefing bench: expected trigger cases fire without network or MCP', () => {
  const cases = [
    {
      name: 'first-turn recall',
      input: { ...base, prompt: 'start this task', recallHasFiredThisSession: false },
      expected: 'fire',
    },
    {
      name: 'short continuation prompt',
      input: { ...base, prompt: 'continue from the previous issue' },
      expected: 'fire',
    },
    {
      name: 'file-specific follow-up',
      input: { ...base, prompt: 'check brainrouter-cli/src/agent/agent.ts again' },
      expected: 'fire',
    },
    {
      name: 'debugging retry after failure',
      input: { ...base, prompt: 'retry the failed npm test path', recentToolFailure: 'npm test: failed' },
      expected: 'fire',
    },
    {
      name: 'post-compaction recall',
      input: { ...base, prompt: 'what next?', postCompaction: true },
      expected: 'fire',
    },
    {
      name: 'child-agent synthesis',
      input: { ...base, prompt: 'synthesize the worker result with the current plan' },
      expected: 'fire',
    },
    {
      name: 'manual fallback for low-information social reply',
      input: { ...base, prompt: 'thanks' },
      expected: 'skip',
    },
  ];

  const report = cases.map((c) => {
    const decision = decideMemoryBriefing(c.input);
    return {
      name: c.name,
      action: decision.action,
      reasons: decision.reasons,
      estimatedBudgetChars: decision.budget.maxCharsPerSource * decision.budget.maxSources,
    };
  });

  for (const row of report) {
    const expected = cases.find((c) => c.name === row.name)?.expected;
    assert.equal(row.action, expected, `${row.name}: ${row.reasons.join(', ')}`);
    assert.ok(row.estimatedBudgetChars > 0);
  }
});

test('briefing bench: compaction reports char savings for noisy tool output', () => {
  const noisyOutput = [
    ...Array.from({ length: 180 }, (_, i) => `Progress ${i}%`),
    'brainrouter-cli/src/agent/agent.ts:12:3 error TS2345: expected string',
    'FAILED brainrouter-cli/src/tests/memory.test.ts',
  ].join('\n');

  const compacted = compactToolOutput({
    toolName: 'run_command',
    args: { command: 'npm test --workspace brainrouter-cli' },
    output: noisyOutput,
  });

  assert.equal(compacted.ruleId, 'command-signal-lines');
  assert.ok(compacted.omittedChars > 0);
  assert.match(compacted.inlineText, /agent\.ts/);
  assert.match(compacted.inlineText, /memory\.test\.ts/);
});

test('briefing bench: buildMemoryBriefing surfaces expected record IDs across all six scenarios', async () => {
  const scenarios: Array<{
    name: string;
    query: string;
    mcpTools: Array<{ name: string }>;
    canned: Record<string, any>;
    expectedSources: string[];
    expectedRecordIds: string[];
  }> = [
    {
      name: 'first-turn recall',
      query: 'start this task',
      mcpTools: [{ name: 'memory_recall' }, { name: 'memory_working_context' }],
      canned: {
        memory_recall: { recalledCognitiveMemories: [{ recordId: 'rec-1', content: 'prior session note' }] },
        memory_working_context: { state: { injectedState: { recentSteps: [{ title: 's', summary: 'x' }] } } },
      },
      expectedSources: ['memory_recall', 'memory_working_context'],
      expectedRecordIds: ['rec-1'],
    },
    {
      name: 'short continuation',
      query: 'continue from the previous issue',
      mcpTools: [{ name: 'memory_recall' }, { name: 'memory_task_state' }],
      canned: {
        memory_recall: { recalledCognitiveMemories: [{ recordId: 'rec-2', content: 'continuation context' }] },
        memory_task_state: { open: ['finish briefing inspector'] },
      },
      expectedSources: ['memory_recall', 'memory_task_state'],
      expectedRecordIds: ['rec-2'],
    },
    {
      name: 'file-specific follow-up',
      query: 'check brainrouter-cli/src/agent/agent.ts again',
      mcpTools: [{ name: 'memory_recall' }, { name: 'memory_file_history' }, { name: 'memory_explain_recall' }],
      canned: {
        memory_recall: { recalledCognitiveMemories: [{ recordId: 'rec-3', content: 'agent edits last week' }] },
        memory_file_history: { records: [{ recordId: 'fh-1', content: 'agent.ts touched 2026-05-26' }] },
        memory_explain_recall: 'recall expansion details',
      },
      expectedSources: ['memory_recall', 'memory_file_history', 'memory_explain_recall'],
      expectedRecordIds: ['rec-3', 'fh-1'],
    },
    {
      name: 'debugging retry after failure',
      query: 'retry the failed npm test path',
      mcpTools: [{ name: 'memory_recall' }, { name: 'memory_failed_attempts' }, { name: 'memory_explain_recall' }],
      canned: {
        memory_recall: { recalledCognitiveMemories: [{ recordId: 'rec-4', content: 'last debug attempt' }] },
        memory_failed_attempts: { records: [{ recordId: 'fa-1', content: 'npm test failed: prior cause' }] },
        memory_explain_recall: 'recall used keyword fallback',
      },
      expectedSources: ['memory_recall', 'memory_failed_attempts', 'memory_explain_recall'],
      expectedRecordIds: ['rec-4', 'fa-1'],
    },
    {
      name: 'post-compaction recall',
      query: 'what next?',
      mcpTools: [{ name: 'memory_recall' }],
      canned: {
        memory_recall: { recalledCognitiveMemories: [{ recordId: 'rec-5', content: 'replay after compaction' }] },
      },
      expectedSources: ['memory_recall'],
      expectedRecordIds: ['rec-5'],
    },
    {
      name: 'child-agent synthesis',
      query: 'synthesize the worker result with the current plan',
      mcpTools: [{ name: 'memory_recall' }, { name: 'memory_working_context' }],
      canned: {
        memory_recall: { recalledCognitiveMemories: [{ recordId: 'rec-6', content: 'parent plan summary' }] },
        memory_working_context: { steps: [{ kind: 'reasoning', title: 'plan', summary: 'p' }] },
      },
      expectedSources: ['memory_recall', 'memory_working_context'],
      expectedRecordIds: ['rec-6'],
    },
  ];

  for (const sc of scenarios) {
    const briefing = await buildMemoryBriefing({
      mcpClient: makeStubClient(sc.canned),
      mcpTools: sc.mcpTools,
      sessionKey: 'bench',
      workspaceRoot: '/tmp/bench-ws',
      query: sc.query,
    });
    for (const id of sc.expectedRecordIds) {
      assert.ok(briefing.recalledRecordIds.includes(id), `${sc.name}: expected record ${id}, got [${briefing.recalledRecordIds.join(', ')}]`);
    }
    for (const src of sc.expectedSources) {
      assert.ok(briefing.sourcesQueried.includes(src), `${sc.name}: expected source ${src}, got [${briefing.sourcesQueried.join(', ')}]`);
    }
    assert.ok(briefing.block.length > 0, `${sc.name}: empty briefing block`);
  }
});

test('briefing bench: missing optional tools degrade silently', async () => {
  const briefing = await buildMemoryBriefing({
    mcpClient: makeStubClient({
      memory_recall: { recalledCognitiveMemories: [{ recordId: 'rec-only', content: 'present' }] },
    }),
    mcpTools: [{ name: 'memory_recall' }],
    sessionKey: 'bench',
    workspaceRoot: '/tmp/bench-ws',
    query: 'check src/foo.ts',
  });
  assert.deepEqual(briefing.recalledRecordIds, ['rec-only']);
  assert.ok(briefing.skippedSources.some((s) => s.source === 'memory_file_history' && /unavailable/.test(s.reason)));
});

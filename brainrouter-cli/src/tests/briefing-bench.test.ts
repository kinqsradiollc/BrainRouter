import test from 'node:test';
import assert from 'node:assert/strict';
import { decideMemoryBriefing } from '../memory/briefingTriggers.js';
import { compactToolOutput } from '../prompt/toolCompaction.js';

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

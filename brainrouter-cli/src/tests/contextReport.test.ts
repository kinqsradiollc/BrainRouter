import test from 'node:test';
import assert from 'node:assert/strict';
import { formatContextReport, type ContextReportInput } from '../runtime/contextReport.js';

const base: ContextReportInput = {
  scope: 'all',
  currentSkill: null,
  session: { promptTokens: 800, completionTokens: 200, turns: 4, calls: 6 },
  bySkill: [
    { skill: 'chat', promptTokens: 100, completionTokens: 20, turns: 1, calls: 1 },
    { skill: 'code-review-and-quality', promptTokens: 600, completionTokens: 150, turns: 2, calls: 4 },
    { skill: 'spec-driven-skill', promptTokens: 100, completionTokens: 30, turns: 1, calls: 1 },
  ],
  byTool: [
    { tool: 'read_file', count: 9 },
    { tool: 'grep_search', count: 3 },
    { tool: 'write_file', count: 5 },
  ],
  briefing: { tokensInjected: 3200, recordsConsulted: 7 },
  children: { count: 0, promptTokens: 0, completionTokens: 0, calls: 0 },
};

test('0.4.x-4 formatContextReport: skills sorted by tokens desc, tools by count desc', () => {
  const out = formatContextReport(base);
  const text = out.join('\n');
  assert.match(text, /Session: 1,000 tokens/);
  // skills: code-review (750) > chat+spec... ensure code-review row precedes spec row
  const skillIdx = out.findIndex((l) => l.includes('code-review-and-quality'));
  const specIdx = out.findIndex((l) => l.includes('spec-driven-skill'));
  assert.ok(skillIdx !== -1 && specIdx !== -1 && skillIdx < specIdx, 'higher-token skill listed first');
  // tools sorted by count: read_file(9) before write_file(5) before grep_search(3)
  const rf = out.findIndex((l) => l.includes('read_file'));
  const wf = out.findIndex((l) => l.includes('write_file'));
  const gs = out.findIndex((l) => l.includes('grep_search'));
  assert.ok(rf < wf && wf < gs, 'tools sorted by call count desc');
  assert.match(text, /Memory briefings: 3,200 tokens injected · 7 records consulted/);
});

test('0.4.x-4 formatContextReport: current scope shows only active skill, no tool table', () => {
  const out = formatContextReport({ ...base, scope: 'current', currentSkill: 'code-review-and-quality' });
  const text = out.join('\n');
  assert.match(text, /By skill — current: code-review-and-quality/);
  assert.ok(out.some((l) => l.includes('code-review-and-quality')), 'current skill row present');
  assert.ok(!out.some((l) => l.includes('spec-driven-skill')), 'other skills excluded in current scope');
  assert.ok(!text.includes('By tool'), 'per-tool table omitted in current scope');
});

test('0.4.x-4 formatContextReport: children fold into a Total line; empty buckets read (none yet)', () => {
  const withKids = formatContextReport({ ...base, children: { count: 2, promptTokens: 400, completionTokens: 100, calls: 3 } });
  assert.match(withKids.join('\n'), /Children \(2\): 500 tokens[\s\S]*Total: 1,500 tokens/);

  const empty = formatContextReport({ ...base, bySkill: [], byTool: [] });
  const text = empty.join('\n');
  assert.ok(text.includes('By skill') && text.includes('(none yet)'), 'empty skills → (none yet)');
});

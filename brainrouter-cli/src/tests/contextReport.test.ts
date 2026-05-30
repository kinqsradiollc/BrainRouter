import test from 'node:test';
import assert from 'node:assert/strict';
import { formatContextReport, type ContextReportInput } from '../runtime/contextReport.js';

const base: ContextReportInput = {
  scope: 'all',
  currentSkill: null,
  window: { current: 45000, max: 200000, autoCompactThreshold: 80000 },
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

test('0.4.x-4b formatContextReport: context-window header with %used + remaining + auto-compact', () => {
  const out = formatContextReport(base).join('\n');
  // 45000/200000 = 22.5% → rounds to 23%; 155000 left.
  assert.match(out, /Context window: ~45,000 \/ 200,000 tokens \(23% used · ~155,000 left\)/);
  assert.match(out, /Auto-compact fires at: 80,000 tokens/);
});

test('0.4.x-4b formatContextReport: unknown model window falls back gracefully', () => {
  const out = formatContextReport({ ...base, window: { current: 12345, max: null, autoCompactThreshold: 80000 } }).join('\n');
  assert.match(out, /Context window: ~12,345 tokens used \(model window unknown\)/);
  assert.ok(!out.includes('% used'), 'no percentage when window is unknown');
});

test('CLI-5 formatContextReport: prompt-cache line shows hit ratio when cache provided', () => {
  const out = formatContextReport({ ...base, cache: { cachedTokens: 6000, missedTokens: 2000 } }).join('\n');
  // 6000 / (6000 + 2000) = 75%.
  assert.match(out, /Prompt cache: 6,000 cached \/ 2,000 missed \(75% hit this session\)/);
});

test('CLI-5 formatContextReport: cache line suppressed when absent or zero', () => {
  assert.ok(!formatContextReport(base).join('\n').includes('Prompt cache:'), 'no cache field → no line');
  const zero = formatContextReport({ ...base, cache: { cachedTokens: 0, missedTokens: 0 } }).join('\n');
  assert.ok(!zero.includes('Prompt cache:'), 'zero prompt tokens → no line (avoids divide-by-zero)');
});

test('CLI-8 formatContextReport: repair line lists only non-zero interventions', () => {
  const out = formatContextReport({
    ...base,
    repair: { scavenged: 2, truncationsFixed: 0, truncationsUnrecoverable: 1, stormsBroken: 3, turnsWithRepair: 4 },
  }).join('\n');
  assert.match(out, /Tool-call repair: 4 turns \(2 scavenged, 1 unrecoverable, 3 storms broken\)/);
  assert.ok(!out.includes('truncation'), 'zero-count categories are omitted');
});

test('CLI-8 formatContextReport: repair line suppressed when clean or absent', () => {
  assert.ok(!formatContextReport(base).join('\n').includes('Tool-call repair:'), 'no repair field → no line');
  const clean = formatContextReport({
    ...base,
    repair: { scavenged: 0, truncationsFixed: 0, truncationsUnrecoverable: 0, stormsBroken: 0, turnsWithRepair: 0 },
  }).join('\n');
  assert.ok(!clean.includes('Tool-call repair:'), 'no interventions → no line (no noise on a healthy session)');
});

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

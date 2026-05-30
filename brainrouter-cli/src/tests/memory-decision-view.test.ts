import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMemoryDecisions } from '../runtime/memoryDecisionView.js';

test('CLI-6 formatMemoryDecisions: decision + sources + skipped + injected records (priority-ordered)', () => {
  const out = formatMemoryDecisions({
    decision: 'inject',
    reasons: ['recall gated open', 'task context'],
    sources: ['memory_recall', 'memory_working_context'],
    sourcesPlanned: ['memory_recall', 'memory_working_context', 'memory_persona'],
    skippedSources: [{ source: 'memory_persona', reason: 'tool unavailable' }],
    recordCount: 2,
    tokensInjected: 1200,
    charsSaved: 3400,
    recalled: [
      { recordId: 'r1', type: 'codebase_fact', priority: 80, content: 'The router uses RRF.' },
      { recordId: 'r2', type: 'instruction', priority: 95, content: 'Always run tests.' },
    ],
  }).join('\n');
  assert.match(out, /Decision: inject/);
  assert.match(out, /Why: recall gated open; task context/);
  assert.match(out, /Sources used: memory_recall, memory_working_context/);
  assert.match(out, /memory_persona — tool unavailable/);
  assert.match(out, /Injected: 2 records · 1,200 tokens · saved 3,400 chars/);
  // highest priority first → r2 (p95) before r1 (p80)
  const idxR2 = out.indexOf('(r2)');
  const idxR1 = out.indexOf('(r1)');
  assert.ok(idxR2 !== -1 && idxR2 < idxR1, 'higher-priority record listed first');
  assert.match(out, /\[instruction\] p95 Always run tests\. \(r2\)/);
});

test('CLI-6 formatMemoryDecisions: none case renders cleanly', () => {
  const out = formatMemoryDecisions({
    decision: 'none', reasons: [], sources: [], sourcesPlanned: [],
    skippedSources: [], recordCount: 0, tokensInjected: 0, charsSaved: 0, recalled: [],
  }).join('\n');
  assert.match(out, /Decision: none/);
  assert.match(out, /Sources used: \(none\)/);
  assert.match(out, /Skipped: \(none\)/);
  assert.match(out, /Injected: 0 records/);
});

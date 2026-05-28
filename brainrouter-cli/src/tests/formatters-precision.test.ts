import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMemories, recallPrecision, renderMemoryCards, type FlatMemory } from '../memory/formatters.js';

function stripAnsi(s: string): string {
  // Strip ANSI escape sequences so assertions don't depend on chalk's
  // current color theme.
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

test('recallPrecision: null when no recall history', () => {
  const m: FlatMemory = { recordId: 'r1', type: 'codebase_fact', content: '' };
  assert.equal(recallPrecision(m), null);
});

test('recallPrecision: cited / (cited + uncited)', () => {
  assert.equal(
    recallPrecision({ recordId: 'r', type: 't', content: '', citationCount: 3, neverCitedCount: 1 }),
    0.75,
  );
  assert.equal(
    recallPrecision({ recordId: 'r', type: 't', content: '', citationCount: 1, neverCitedCount: 9 }),
    0.1,
  );
  assert.equal(
    recallPrecision({ recordId: 'r', type: 't', content: '', citationCount: 0, neverCitedCount: 5 }),
    0,
  );
});

test('extractMemories: pulls citationCount + neverCitedCount from MCP payload (camelCase)', () => {
  const mem = extractMemories({
    recalledCognitiveMemories: [
      {
        recordId: 'rec-a',
        type: 'codebase_fact',
        content: 'auth.ts:63 returns apiKey in sign-in response',
        citationCount: 4,
        neverCitedCount: 1,
      },
    ],
  });
  assert.equal(mem[0].citationCount, 4);
  assert.equal(mem[0].neverCitedCount, 1);
  assert.equal(recallPrecision(mem[0]), 0.8);
});

test('extractMemories: tolerates snake_case from older payloads', () => {
  const mem = extractMemories({
    records: [
      {
        record_id: 'rec-b',
        type: 'instruction',
        content: 'be terse',
        citation_count: 0,
        never_cited_count: 7,
      },
    ],
  });
  assert.equal(mem[0].citationCount, 0);
  assert.equal(mem[0].neverCitedCount, 7);
});

test('renderMemoryCards: hides badge when record has no recall history', () => {
  const out = stripAnsi(renderMemoryCards(
    [{ recordId: 'r', type: 'codebase_fact', content: 'fresh extraction' }],
    'Test',
  ));
  assert.doesNotMatch(out, /cited \d+/);
  assert.doesNotMatch(out, /uncited \d+/);
});

test('renderMemoryCards: shows precision badge when history exists', () => {
  const out = stripAnsi(renderMemoryCards(
    [
      {
        recordId: 'rec-a',
        type: 'codebase_fact',
        content: 'something',
        citationCount: 3,
        neverCitedCount: 1,
      },
    ],
    'Test',
  ));
  assert.match(out, /cited 3 · uncited 1 \(75%\)/);
  assert.doesNotMatch(out, /noisy/);
});

test('renderMemoryCards: flags records below 20% precision as noisy', () => {
  const out = stripAnsi(renderMemoryCards(
    [
      {
        recordId: 'rec-noisy',
        type: 'codebase_fact',
        content: 'often recalled, rarely cited',
        citationCount: 1,
        neverCitedCount: 9,
      },
    ],
    'Test',
  ));
  assert.match(out, /cited 1 · uncited 9 \(10%\)/);
  assert.match(out, /⚠️ noisy/);
});

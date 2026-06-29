import test from 'node:test';
import assert from 'node:assert/strict';
import {
  writeThreadKey,
  buildGroundingBlock,
  pickLocalGrounding,
  type WorkspaceDoc,
} from '../write/grounding.js';

test('writeThreadKey: stable, write-prefixed, distinct per workspace', () => {
  const a = writeThreadKey('/repo/alpha');
  assert.match(a, /^write:[a-z0-9]+$/);
  assert.equal(a, writeThreadKey('/repo/alpha'), 'stable for the same root');
  assert.notEqual(a, writeThreadKey('/repo/beta'), 'distinct per root');
});

test('buildGroundingBlock: formats snippets with a header; empty input → no block', () => {
  assert.equal(buildGroundingBlock([]), '');
  assert.equal(buildGroundingBlock([{ source: 'x.md', excerpt: '   ' }]), '', 'blank excerpts drop out');
  const block = buildGroundingBlock([
    { source: 'guide.md', excerpt: 'Use tabs, not spaces.' },
    { source: 'voice.md', excerpt: 'Write in the active voice.' },
  ]);
  assert.match(block, /^## Grounding/);
  assert.match(block, /### guide\.md/);
  assert.match(block, /Use tabs, not spaces\./);
  assert.match(block, /### voice\.md/);
});

test('buildGroundingBlock: caps by whole snippets, never mid-snippet', () => {
  const big = 'x'.repeat(300);
  const block = buildGroundingBlock(
    [{ source: 'a', excerpt: big }, { source: 'b', excerpt: big }, { source: 'c', excerpt: big }],
    400, // only the first snippet fits under the cap
  );
  assert.match(block, /### a/);
  assert.ok(!block.includes('### b'), 'second snippet excluded whole');
});

test('pickLocalGrounding: keyword overlap ranks docs, excludes the current doc', () => {
  const docs: WorkspaceDoc[] = [
    { path: 'recall.md', content: 'The recall pipeline blends reranker and RRF for memory.' },
    { path: 'unrelated.md', content: 'A recipe for sourdough bread.' },
    { path: 'current.md', content: 'memory recall reranker notes' },
  ];
  const hits = pickLocalGrounding('how does memory recall reranker work', docs, 'current.md');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].source, 'recall.md', 'most-overlapping doc first');
  assert.ok(!hits.some((h) => h.source === 'current.md'), 'current doc excluded');
  assert.ok(!hits.some((h) => h.source === 'unrelated.md'), 'non-overlapping doc dropped');
  assert.match(hits[0].excerpt, /recall pipeline/);
});

test('pickLocalGrounding: no usable query terms → no grounding', () => {
  const docs: WorkspaceDoc[] = [{ path: 'a.md', content: 'something' }];
  assert.deepEqual(pickLocalGrounding('a I to', docs), []); // all terms < 3 chars
  assert.deepEqual(pickLocalGrounding('', docs), []);
});

test('pickLocalGrounding: respects the max cap', () => {
  const docs: WorkspaceDoc[] = Array.from({ length: 6 }, (_, i) => ({ path: `d${i}.md`, content: 'memory recall blend' }));
  assert.equal(pickLocalGrounding('memory recall', docs, undefined, 2).length, 2);
});

/**
 * ADR-027 D4 (P8-1) — chunking with exact offsets.
 *
 * The invariant everything else depends on: `source.slice(chunk.start,
 * chunk.end) === chunk.text`, for every chunk, always. Break it and citations
 * silently resolve to the wrong span — and the damage grows with breadcrumb
 * depth, so the deepest sections, the ones most worth citing, are the most
 * wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkDocument,
  sectionsWithOffsets,
  embeddingText,
  verifyChunkOffsets,
} from '../document/chunking.js';

const DOC = [
  '# Guide',
  '',
  'Intro paragraph.',
  '',
  '## Auth',
  '',
  'Auth body text.',
  '',
  '### Tokens',
  '',
  'Token rotation details.',
].join('\n');

test('offsets resolve exactly against the source — the core invariant', () => {
  const chunks = chunkDocument(DOC, { maxChars: 40 });
  assert.ok(chunks.length > 0);
  assert.deepEqual(verifyChunkOffsets(DOC, chunks), []);
  for (const chunk of chunks) {
    assert.equal(DOC.slice(chunk.start, chunk.end), chunk.text);
  }
});

test('the breadcrumb is NOT part of the chunk text', () => {
  // Prepending it is the tempting one-line implementation that destroys every
  // offset. The chunk must start exactly where it claims to.
  const chunks = chunkDocument(DOC, { maxChars: 200 });
  const tokens = chunks.find((c) => c.text.includes('Token rotation'))!;
  assert.deepEqual(tokens.breadcrumb, ['Guide', 'Auth', 'Tokens']);
  assert.doesNotMatch(tokens.text, /Guide > Auth/);
  assert.equal(DOC.slice(tokens.start, tokens.end), tokens.text);
});

test('embedding text adds the breadcrumb without touching the stored chunk', () => {
  const chunks = chunkDocument(DOC, { maxChars: 200 });
  const tokens = chunks.find((c) => c.text.includes('Token rotation'))!;
  const embedded = embeddingText(tokens);
  assert.match(embedded, /^Guide > Auth > Tokens/);
  assert.match(embedded, /Token rotation/);
  assert.equal(DOC.slice(tokens.start, tokens.end), tokens.text, 'the chunk is unchanged');
});

test('heading depth builds a nested breadcrumb', () => {
  const sections = sectionsWithOffsets(DOC);
  assert.deepEqual(sections.map((s) => s.breadcrumb), [
    ['Guide'], ['Guide', 'Auth'], ['Guide', 'Auth', 'Tokens'],
  ]);
});

test('a skipped heading level attaches where it lands, uncorrected', () => {
  // Real documents skip levels constantly. Inventing an intermediate would put
  // a citation under a section that does not exist.
  const doc = '# Top\n\nA.\n\n### Deep\n\nB.';
  assert.deepEqual(
    sectionsWithOffsets(doc).map((s) => s.breadcrumb),
    [['Top'], ['Top', 'Deep']],
  );
});

test('a sibling heading pops the stack rather than nesting', () => {
  const doc = '# A\n\nx.\n\n## B1\n\ny.\n\n## B2\n\nz.';
  assert.deepEqual(
    sectionsWithOffsets(doc).map((s) => s.breadcrumb),
    [['A'], ['A', 'B1'], ['A', 'B2']],
  );
});

test('a heading inside fenced code is not a heading', () => {
  // Otherwise a shell snippet shatters the document and every offset after it
  // belongs to the wrong section.
  const doc = '## Setup\n\n```bash\n# install\nnpm ci\n```\n\nDone.';
  const sections = sectionsWithOffsets(doc);
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0]!.breadcrumb, ['Setup']);
  assert.match(sections[0]!.text, /# install/);
});

test('chunks never span two sections', () => {
  // A chunk carrying text from two parts of a document has no honest
  // breadcrumb, and a citation into it points at no real unit.
  const chunks = chunkDocument(DOC, { maxChars: 1_000 });
  for (const chunk of chunks) {
    const headings = chunk.text.match(/^#{1,6}\s/gm) ?? [];
    assert.equal(headings.length, 0, 'a chunk should not contain a heading line');
  }
  assert.ok(chunks.length >= 3, 'one per section at minimum');
});

test('splitting prefers a boundary over cutting mid-token', () => {
  const doc = '# T\n\n' + 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu.';
  const chunks = chunkDocument(doc, { maxChars: 30 });
  assert.deepEqual(verifyChunkOffsets(doc, chunks), []);
  for (const chunk of chunks.slice(0, -1)) {
    assert.doesNotMatch(chunk.text, /\w$/, 'a chunk should not end mid-word');
  }
});

test('overlap keeps offsets exact and still terminates', () => {
  const doc = '# T\n\n' + 'word '.repeat(60).trim();
  const chunks = chunkDocument(doc, { maxChars: 50, overlapChars: 20 });
  assert.deepEqual(verifyChunkOffsets(doc, chunks), []);
  assert.ok(chunks.length > 1);
  // Overlapping chunks must still advance, or this loops forever.
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i]!.start > chunks[i - 1]!.start, 'each chunk starts later than the last');
  }
});

test('an overlap at or above the chunk size is clamped rather than hanging', () => {
  const doc = '# T\n\n' + 'word '.repeat(40).trim();
  const chunks = chunkDocument(doc, { maxChars: 30, overlapChars: 999 });
  assert.ok(chunks.length > 1);
  assert.deepEqual(verifyChunkOffsets(doc, chunks), []);
});

test('verification catches a chunk whose text was altered without its offsets', () => {
  // The entire class of bug this module exists to prevent, surfaced cheaply
  // rather than as a subtly wrong citation months later.
  const chunks = chunkDocument(DOC, { maxChars: 200 });
  const tampered = chunks.map((c, i) => (i === 0 ? { ...c, text: `PREFIX ${c.text}` } : c));
  const problems = verifyChunkOffsets(DOC, tampered);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /does not match source/);
});

test('an empty or whitespace-only document produces no chunks', () => {
  assert.deepEqual(chunkDocument('', { maxChars: 100 }), []);
  assert.deepEqual(chunkDocument('   \n\n  ', { maxChars: 100 }), []);
});

test('a document with no headings still chunks with an empty breadcrumb', () => {
  const doc = 'Just prose, no structure at all here.';
  const chunks = chunkDocument(doc, { maxChars: 100 });
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0]!.breadcrumb, []);
  assert.equal(embeddingText(chunks[0]!), chunks[0]!.text, 'no breadcrumb, no header');
  assert.deepEqual(verifyChunkOffsets(doc, chunks), []);
});

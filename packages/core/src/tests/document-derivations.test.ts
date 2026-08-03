/**
 * ADR-027 D4 (P8-2) — per-profile derivations over one shared substrate.
 *
 * The structural rule under test: a derivation REFERENCES substrate chunks and
 * never carries its own copy of the text. The moment it embeds text there are N
 * copies of a document drifting independently — silently, because each copy
 * looks internally consistent. A research claim quoting a paragraph the source
 * no longer contains is not detectably wrong from inside the claim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILE_DERIVATIONS,
  profileDerives,
  derivationProblems,
  resolveDerivations,
  viewForProfile,
  availableProfiles,
  DerivationError,
  type DerivedItem,
} from '../document/derivations.js';
import { chunkDocument } from '../document/chunking.js';

const DOC = '# Guide\n\nThe system retries three times.\n\n## API\n\nfetchUser(id: string): User';
const CHUNKS = chunkDocument(DOC, { maxChars: 200 });

const item = (over: Partial<DerivedItem> = {}): DerivedItem => ({
  kind: 'claim', chunkIndex: 0, content: 'The system retries three times.', ...over,
});

test('a derived item carries NO copy of the source text', () => {
  // The whole design. If it embedded text, five profiles would hold five
  // copies that drift apart without any of them looking wrong.
  const derived = item();
  assert.ok(!('sourceText' in derived), 'source text is not part of a derived item');
  assert.ok(!('text' in derived));
  assert.equal(typeof derived.chunkIndex, 'number', 'it references, it does not copy');
});

test('source text is fetched from the substrate at read time', () => {
  const [resolved] = resolveDerivations([item()], CHUNKS);
  assert.equal(resolved!.sourceText, CHUNKS[0]!.text);
  assert.deepEqual(resolved!.breadcrumb, CHUNKS[0]!.breadcrumb);
});

test('fixing the substrate fixes every profile at once', () => {
  // The consequence of referencing rather than copying: re-chunk once, and
  // every derivation resolves against the corrected text.
  const corrected = chunkDocument(DOC.replace('three times', 'five times'), { maxChars: 200 });
  const [resolved] = resolveDerivations([item()], corrected);
  assert.match(resolved!.sourceText, /five times/);
});

test('a dangling chunk reference throws rather than being dropped', () => {
  // A view that quietly omits items is indistinguishable from one where the
  // extractor found less, and the two call for completely different responses.
  assert.throws(() => resolveDerivations([item({ chunkIndex: 99 })], CHUNKS), DerivationError);
});

test('validation catches a reference into nothing', () => {
  // Worse than no citation, because it renders as verifiable.
  const problems = derivationProblems([item({ chunkIndex: 99 })], CHUNKS, 'research');
  assert.ok(problems.some((p) => /does not exist/.test(p)));
});

test('validation catches a kind the profile does not derive', () => {
  // The mapping and the extractor disagreeing surfaces later as a view that is
  // mysteriously empty or mysteriously full.
  const problems = derivationProblems([item({ kind: 'question' })], CHUNKS, 'research');
  assert.ok(problems.some((p) => /the research profile does not derive/.test(p)));
});

test('validation catches empty content', () => {
  assert.ok(derivationProblems([item({ content: '   ' })], CHUNKS, 'research')
    .some((p) => /has no content/.test(p)));
});

test('a sound set validates clean', () => {
  assert.deepEqual(derivationProblems([item()], CHUNKS, 'research'), []);
});

test('each profile derives only its own kinds', () => {
  assert.ok(profileDerives('research', 'claim'));
  assert.ok(profileDerives('study', 'question'));
  assert.ok(profileDerives('engineering', 'api-contract'));
  assert.ok(!profileDerives('research', 'question'));
  assert.ok(!profileDerives('writing', 'spec'));
});

test('one substrate serves every profile by FILTERING, never re-extracting', () => {
  // This is D4's claim made mechanical: the same item list, viewed differently.
  const items = [
    item({ kind: 'claim' }),
    item({ kind: 'question', content: 'How many retries?' }),
    item({ kind: 'api-contract', chunkIndex: 1, content: 'fetchUser(id: string): User' }),
  ];
  assert.deepEqual(viewForProfile(items, 'research').map((i) => i.kind), ['claim']);
  assert.deepEqual(viewForProfile(items, 'study').map((i) => i.kind), ['question']);
  assert.deepEqual(viewForProfile(items, 'engineering').map((i) => i.kind), ['api-contract']);
});

test('a profile that derived nothing yields an empty view, not an error', () => {
  // A document with no API contracts in it is a normal document.
  assert.deepEqual(viewForProfile([item({ kind: 'claim' })], 'data-science'), []);
});

test('only profiles with something to show are offered', () => {
  // Five tabs where four are blank reads as broken rather than as inapplicable.
  const items = [item({ kind: 'claim' }), item({ kind: 'table', content: 'a,b' })];
  assert.deepEqual(availableProfiles(items), ['research', 'data-science']);
  assert.deepEqual(availableProfiles([]), []);
});

test('every profile declares at least one kind, and kinds are not shared', () => {
  // A kind claimed by two profiles would make viewForProfile ambiguous.
  const seen = new Set<string>();
  for (const [profile, kinds] of Object.entries(PROFILE_DERIVATIONS)) {
    assert.ok(kinds.length > 0, `${profile} derives nothing`);
    for (const kind of kinds) {
      assert.ok(!seen.has(kind), `kind "${kind}" is claimed by more than one profile`);
      seen.add(kind);
    }
  }
});

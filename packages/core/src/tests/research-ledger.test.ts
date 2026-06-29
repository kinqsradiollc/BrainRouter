import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLedger,
  addEntry,
  crossCheck,
  summarizeLedger,
  formatBrief,
} from '../research/evidenceLedger.js';
import { setQuestion, appendEvidence, readLedger, clearLedger } from '../research/researchStore.js';
import { withTempWorkspace } from './_helpers.js';

const NOW = '2026-06-29T00:00:00.000Z';

test('addEntry: deterministic ids, defaults, trims sources', () => {
  let led = createLedger('Is X true?', NOW);
  led = addEntry(led, { claim: 'X is true', sources: [' https://a ', ''], stance: 'support', confidence: 'high' }, NOW);
  led = addEntry(led, { claim: 'Y is unknown' }, NOW);
  assert.equal(led.entries[0].id, 'ev_1');
  assert.equal(led.entries[1].id, 'ev_2');
  assert.deepEqual(led.entries[0].sources, ['https://a']);
  assert.equal(led.entries[1].stance, 'unclear'); // default
  assert.equal(led.entries[1].confidence, 'low'); // default
  assert.throws(() => addEntry(led, { claim: '   ' }, NOW), /non-empty claim/);
});

test('crossCheck: corroborated / conflicting / single-source classification', () => {
  let led = createLedger('Q', NOW);
  // same claim, two independent sources, both support → corroborated
  led = addEntry(led, { claim: 'Sky is blue', sources: ['s1'], stance: 'support' }, NOW);
  led = addEntry(led, { claim: 'sky is blue', sources: ['s2'], stance: 'support' }, NOW);
  // a claim with a support and a refute → conflicting
  led = addEntry(led, { claim: 'Coffee is healthy', sources: ['s3'], stance: 'support' }, NOW);
  led = addEntry(led, { claim: 'Coffee is healthy', sources: ['s4'], stance: 'refute' }, NOW);
  // single-source
  led = addEntry(led, { claim: 'Niche fact', sources: ['s5'], stance: 'support' }, NOW);

  const checks = crossCheck(led);
  const blue = checks.find((c) => c.claim === 'Sky is blue')!;
  const coffee = checks.find((c) => /coffee/i.test(c.claim))!;
  const niche = checks.find((c) => /niche/i.test(c.claim))!;
  assert.equal(blue.corroborated, true);
  assert.equal(blue.sourceCount, 2);
  assert.equal(coffee.conflicting, true);
  assert.equal(coffee.corroborated, false);
  assert.equal(niche.singleSource, true);

  const s = summarizeLedger(led);
  assert.equal(s.total, 5);
  assert.equal(s.corroborated, 1);
  assert.equal(s.conflicting, 1);
  assert.equal(s.singleSource, 1);
});

test('formatBrief: renders findings + uncertainty section', () => {
  let led = createLedger('Should we adopt Foo?', NOW);
  led = addEntry(led, { claim: 'Foo is fast', sources: ['bench'], stance: 'support', confidence: 'medium', note: 'p95 improved' }, NOW);
  led = addEntry(led, { claim: 'Foo is risky', sources: ['issue1'], stance: 'support' }, NOW);
  led = addEntry(led, { claim: 'Foo is risky', sources: ['blog'], stance: 'refute' }, NOW);
  const md = formatBrief(led);
  assert.match(md, /# Research brief: Should we adopt Foo\?/);
  assert.match(md, /Foo is fast/);
  assert.match(md, /p95 improved/);
  assert.match(md, /## Uncertainty & conflicts/);
  assert.match(md, /Conflicting evidence.*Foo is risky/);
  assert.match(md, /Single source.*Foo is fast/);
});

test('formatBrief: empty ledger is graceful', () => {
  const md = formatBrief(createLedger('Open question', NOW));
  assert.match(md, /No evidence recorded yet/);
});

test('researchStore: setQuestion / appendEvidence / read / clear (session-scoped)', () => {
  withTempWorkspace((ws) => {
    const sk = 'session:research';
    assert.equal(readLedger(ws, sk), null);

    appendEvidence(ws, sk, { claim: 'auto-starts a ledger', sources: ['x'], stance: 'support' });
    let led = readLedger(ws, sk)!;
    assert.equal(led.entries.length, 1);
    assert.equal(led.question, ''); // auto-started with empty question

    setQuestion(ws, sk, 'What is the answer?');
    led = readLedger(ws, sk)!;
    assert.equal(led.question, 'What is the answer?');
    assert.equal(led.entries.length, 1, 'setQuestion preserves entries');

    clearLedger(ws, sk);
    assert.equal(readLedger(ws, sk), null);
  });
});

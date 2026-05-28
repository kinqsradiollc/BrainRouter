import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN_OUTPUT_CONTRACTS,
  describeContractForPrompt,
  getOutputContract,
  parseChildOutput,
} from '../orchestration/outputContracts.js';

/**
 * MAS-P2-M5 — output-contract scaffolding tests.
 *
 * Covers the three responsibilities of the module:
 *
 *   1. Catalog correctness — the five built-in contracts exist, each
 *      has a non-empty headline + at least one required field.
 *   2. Prompt rendering — `describeContractForPrompt` produces a
 *      "Required structured output" block with every field's heading
 *      and description, and tags optional fields as such.
 *   3. Tolerant parser — `parseChildOutput` returns `parsed` when
 *      every required heading is present with body content, and
 *      `unparsed` when one is missing. Tolerant means: heading
 *      level (h1/h2/h3) is forgiving, unknown headings don't bleed
 *      into known sections, and a `*optional*` tag on the heading
 *      is accepted.
 */

test('catalog: five built-in contracts exist with at least one required field each', () => {
  const expectedIds = ['explorer', 'architect', 'reviewer', 'worker', 'verifier'];
  for (const id of expectedIds) {
    const contract = BUILT_IN_OUTPUT_CONTRACTS[id];
    assert.ok(contract, `missing contract ${id}`);
    assert.equal(contract.id, id);
    const required = contract.fields.filter((f) => f.required);
    assert.ok(required.length >= 1, `${id} must declare ≥1 required field`);
    // Every contract leads with a `headline` field — universal to keep
    // the existing extractChildPreview path working.
    assert.equal(contract.fields[0].name, 'headline');
  }
});

test('getOutputContract: returns null for unknown roles', () => {
  assert.equal(getOutputContract('nonexistent'), null);
  assert.equal(getOutputContract(''), null);
  assert.equal(getOutputContract(undefined), null);
  assert.equal(getOutputContract(null), null);
});

test('describeContractForPrompt: renders a "Required structured output" block with every field', () => {
  const block = describeContractForPrompt(BUILT_IN_OUTPUT_CONTRACTS.worker);
  assert.match(block, /## Required structured output/);
  for (const field of BUILT_IN_OUTPUT_CONTRACTS.worker.fields) {
    assert.ok(
      block.includes(`### ${field.heading}`) || block.includes(`### ${field.heading} *(optional)*`),
      `field ${field.name} missing from prompt block`,
    );
    if (!field.required) {
      assert.ok(
        block.includes(`### ${field.heading} *(optional)*`),
        `optional field ${field.name} must be tagged optional`,
      );
    }
  }
});

test('parseChildOutput: returns parsed when all required fields are present', () => {
  const text = [
    '## Headline',
    'Shipped the Hero component.',
    '',
    '## Files changed',
    '- src/components/hero.ts (+42 / -0)',
    '',
    '## Summary',
    'Implemented the hero per the architecture spec.',
  ].join('\n');
  const out = parseChildOutput('worker', text);
  assert.ok(out);
  assert.equal(out!.contractStatus, 'parsed');
  assert.match(out!.fields.headline, /Shipped the Hero/);
  assert.match(out!.fields.filesChanged, /hero\.ts/);
  assert.match(out!.fields.summary, /architecture spec/);
});

test('parseChildOutput: returns unparsed when a required field is missing', () => {
  const text = [
    '## Headline',
    'Did some work.',
    '',
    '## Files changed',
    '- foo.ts',
    // Missing `## Summary` (required for worker).
  ].join('\n');
  const out = parseChildOutput('worker', text);
  assert.ok(out);
  assert.equal(out!.contractStatus, 'unparsed');
  assert.deepEqual(out!.missing, ['summary']);
  // Found fields still surface so callers can render partials.
  assert.match(out!.fields.headline, /Did some work/);
});

test('parseChildOutput: tolerates h1 / h3 heading levels, not just h2', () => {
  const text = [
    '# Headline',
    'Top-level heading.',
    '',
    '### Files changed',
    '- a.ts',
    '',
    '## Summary',
    'OK.',
  ].join('\n');
  const out = parseChildOutput('worker', text);
  assert.ok(out);
  assert.equal(out!.contractStatus, 'parsed');
});

test('parseChildOutput: unknown headings do not leak content into known sections', () => {
  const text = [
    '## Headline',
    'Real headline.',
    '',
    '## Some Other Section',
    'This text must NOT be captured into the next known field.',
    '',
    '## Summary',
    'Real summary.',
    '',
    '## Files changed',
    '- a.ts',
  ].join('\n');
  const out = parseChildOutput('worker', text);
  assert.ok(out);
  assert.equal(out!.contractStatus, 'parsed');
  assert.doesNotMatch(out!.fields.headline, /Other Section/);
  assert.doesNotMatch(out!.fields.summary, /Other Section/);
});

test('parseChildOutput: accepts the *(optional)* tag on a heading without dropping the field', () => {
  // The prompt block renders optional fields as `### Heading *(optional)*`.
  // The model may echo that exact form back; the parser must strip it.
  const text = [
    '## Headline',
    'OK.',
    '',
    '## Files changed *(optional)*',
    '- a.ts',
    '',
    '## Summary',
    'fine.',
  ].join('\n');
  const out = parseChildOutput('worker', text);
  assert.ok(out);
  assert.equal(out!.contractStatus, 'parsed');
  assert.match(out!.fields.filesChanged, /a\.ts/);
});

test('parseChildOutput: returns null for unknown role (caller treats as "no contract")', () => {
  assert.equal(parseChildOutput('nonexistent', '## Headline\nfoo'), null);
});

test('parseChildOutput: handles empty / nullish input by reporting every required field as missing', () => {
  const out = parseChildOutput('worker', '');
  assert.ok(out);
  assert.equal(out!.contractStatus, 'unparsed');
  assert.ok(out!.missing.includes('headline'));
  assert.ok(out!.missing.includes('filesChanged'));
  assert.ok(out!.missing.includes('summary'));
});

test('parseChildOutput: reviewer + architect contracts parse representative output', () => {
  const reviewer = parseChildOutput(
    'reviewer',
    [
      '## Headline',
      '3 concerns, all medium severity.',
      '',
      '## Findings',
      '- [severity:medium] [confidence:80] src/a.ts:42 — unused import',
      '- [severity:medium] [confidence:75] src/b.ts:10 — missing null guard',
      '- [severity:medium] [confidence:60] src/c.ts:1 — file lacks header docstring',
    ].join('\n'),
  );
  assert.equal(reviewer?.contractStatus, 'parsed');
  assert.match(reviewer!.fields.findings, /unused import/);

  const architect = parseChildOutput(
    'architect',
    [
      '## Headline',
      'Pick option B.',
      '',
      '## Alternatives',
      '1. Inline component.',
      '2. Lazy-loaded module.',
      '',
      '## Tradeoffs',
      '- Inline: simpler / heavier first-paint',
      '- Lazy: leaner first-paint / cache-cold cost',
      '',
      '## Recommendation',
      'Lazy-loaded module — first paint dominates.',
    ].join('\n'),
  );
  assert.equal(architect?.contractStatus, 'parsed');
  assert.match(architect!.fields.recommendation, /Lazy-loaded/);
});

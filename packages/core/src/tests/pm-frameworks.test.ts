import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PM_FRAMEWORKS,
  getPmFramework,
  listPmFrameworks,
  isFrameworkArmed,
  collectArmedGuidance,
  composeArmedSystemAddendum,
} from '../requirement/pmFrameworks.js';

test('registry integrity: unique kebab ids, valid groups, non-empty fields', () => {
  const ids = new Set<string>();
  for (const f of PM_FRAMEWORKS) {
    assert.match(f.id, /^[a-z][a-z0-9-]*$/, `id "${f.id}" should be kebab-case`);
    assert.ok(!ids.has(f.id), `duplicate id ${f.id}`);
    ids.add(f.id);
    assert.ok(['discover', 'structure', 'risk'].includes(f.group), `bad group ${f.group}`);
    assert.ok(f.label.trim().length > 0);
    assert.ok(f.composerText.trim().length > 0);
    assert.ok(f.guidance.trim().length > 0);
  }
  // all three groups represented
  const groups = new Set(PM_FRAMEWORKS.map((f) => f.group));
  assert.deepEqual([...groups].sort(), ['discover', 'risk', 'structure']);
});

test('getPmFramework / listPmFrameworks', () => {
  assert.equal(getPmFramework('pre-mortem')?.group, 'risk');
  assert.equal(getPmFramework('does-not-exist'), undefined);
  const discover = listPmFrameworks('discover');
  assert.ok(discover.length > 0);
  assert.ok(discover.every((f) => f.group === 'discover'));
  assert.equal(listPmFrameworks().length, PM_FRAMEWORKS.length);
});

test('isFrameworkArmed: present → armed; edited away → disarmed', () => {
  const fw = getPmFramework('clarify-missing')!;
  // exact injected text present
  assert.ok(isFrameworkArmed(fw.composerText, fw));
  // present with surrounding text + reflowed whitespace
  assert.ok(isFrameworkArmed(`Hi.\n\n${fw.composerText}\n\nthanks`, fw));
  assert.ok(isFrameworkArmed(fw.composerText.replace(/ /g, '  '), fw));
  // deleted / materially rewritten → not armed
  assert.ok(!isFrameworkArmed('completely different message', fw));
  assert.ok(!isFrameworkArmed('', fw));
});

test('collectArmedGuidance + addendum reflect send-time presence (gating)', () => {
  const a = getPmFramework('split-r-blocks')!;
  const b = getPmFramework('pre-mortem')!;
  const composer = `${a.composerText}\n${b.composerText}`;
  const guidance = collectArmedGuidance(composer);
  assert.ok(guidance.includes(a.guidance));
  assert.ok(guidance.includes(b.guidance));

  const addendum = composeArmedSystemAddendum(composer);
  assert.match(addendum, /Active product-management frameworks/);
  assert.ok(addendum.includes(a.guidance));

  // none present → empty addendum (caller skips injection)
  assert.equal(composeArmedSystemAddendum('unrelated text'), '');
  assert.deepEqual(collectArmedGuidance('unrelated text'), []);
});

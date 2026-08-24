/**
 * ADR-047 D4 (P4b) — the advisory gate: a plugin with a published advisory
 * cannot install SILENTLY.
 *
 * The properties: policy 'off' never checks; a hit blocks under 'block' and
 * warns under 'warn', each CITING the advisory; a source that cannot answer
 * fails OPEN (a warn, never a block) so a flaky lookup can't wedge every install.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePluginAdvisory, type PluginAdvisory } from './advisory.js';
import type { MarketplacePluginEntry } from './marketplace.js';

const entry: MarketplacePluginEntry = { name: 'acme-devkit', source: 'git+https://x.test/acme.git' };
const hit: PluginAdvisory[] = [{ id: 'GHSA-xxxx-yyyy-zzzz', summary: 'RCE' }];

const sourceWith = (findings: PluginAdvisory[]) => async () => findings;
const throwingSource = async () => { throw new Error('osv unreachable'); };

test('policy off never checks (the source is not even called)', async () => {
  let called = false;
  const v = await evaluatePluginAdvisory(entry, 'off', async () => { called = true; return hit; });
  assert.equal(v.verdict, 'ok');
  assert.equal(called, false);
});

test('a hit under BLOCK refuses and cites the advisory', async () => {
  const v = await evaluatePluginAdvisory(entry, 'block', sourceWith(hit));
  assert.equal(v.verdict, 'block');
  assert.match(v.message ?? '', /GHSA-xxxx-yyyy-zzzz/);
  assert.match(v.message ?? '', /acme-devkit/);
});

test('a hit under WARN proceeds but surfaces the advisory', async () => {
  const v = await evaluatePluginAdvisory(entry, 'warn', sourceWith(hit));
  assert.equal(v.verdict, 'warn');
  assert.match(v.message ?? '', /GHSA-xxxx-yyyy-zzzz/);
});

test('no findings is ok under either policy', async () => {
  assert.equal((await evaluatePluginAdvisory(entry, 'block', sourceWith([]))).verdict, 'ok');
  assert.equal((await evaluatePluginAdvisory(entry, 'warn', sourceWith([]))).verdict, 'ok');
});

test('a source that cannot answer FAILS OPEN — a warn under block, never a block', async () => {
  const v = await evaluatePluginAdvisory(entry, 'block', throwingSource);
  assert.equal(v.verdict, 'warn');
  assert.match(v.message ?? '', /could not complete/);
});

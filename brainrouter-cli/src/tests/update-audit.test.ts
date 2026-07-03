import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuditJson, decideUpdate, runAuditedUpdate } from '../runtime/update/updateApply.js';
import type { UpdateCheckResult } from '../runtime/update/updateCheck.js';

const behind: UpdateCheckResult = { current: '0.4.14', latest: '0.4.15', behind: true, command: 'npm i -g x@latest' };

test('parseAuditJson: reads vulnerability counts; tolerant of garbage', () => {
  const a = parseAuditJson(JSON.stringify({ metadata: { vulnerabilities: { critical: 2, high: 1, moderate: 0, low: 3, total: 6 } } }));
  assert.equal(a.critical, 2);
  assert.equal(a.high, 1);
  assert.match(a.summary, /critical 2/);
  assert.deepEqual(parseAuditJson('not json'), { critical: 0, high: 0, summary: 'audit unavailable' });
});

test('decideUpdate: a critical advisory BLOCKS auto-install; clean does not', () => {
  const blocked = decideUpdate(behind, { critical: 1, high: 0, summary: '1' });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason!, /critical/);
  const clean = decideUpdate(behind, { critical: 0, high: 2, summary: '2' });
  assert.equal(clean.blocked, false);
});

test('runAuditedUpdate: apply installs when clean, REFUSES on a critical advisory', async () => {
  let installs = 0;
  const install = async () => { installs++; return { ok: true, output: 'done' }; };

  // critical → blocked, no install
  const blocked = await runAuditedUpdate({
    apply: true,
    check: async () => behind,
    audit: async () => JSON.stringify({ metadata: { vulnerabilities: { critical: 1, total: 1 } } }),
    install,
  });
  assert.equal(blocked.decision!.blocked, true);
  assert.equal(blocked.installed, false);
  assert.equal(installs, 0, 'never installs a critical-flagged update');

  // clean → installs
  const ok = await runAuditedUpdate({
    apply: true,
    check: async () => behind,
    audit: async () => JSON.stringify({ metadata: { vulnerabilities: { critical: 0, total: 0 } } }),
    install,
  });
  assert.equal(ok.installed, true);
  assert.equal(installs, 1);
});

test('runAuditedUpdate: up to date → no decision-to-apply, no install', async () => {
  let installs = 0;
  const r = await runAuditedUpdate({
    apply: true,
    check: async () => ({ current: '0.4.15', latest: '0.4.15', behind: false, command: 'x' }),
    install: async () => { installs++; return { ok: true, output: '' }; },
  });
  assert.equal(r.installed, false);
  assert.equal(installs, 0);
});

/**
 * ADR-047 P3 — the playbook artifact: parsed, typed, validated, substituted.
 *
 * The one genuinely new mechanism is TYPED PARAMETERS (nothing else in the
 * codebase validated them), so these assertions lean on: parse the frontmatter +
 * params block, refuse a run missing a required param or with a mis-typed value,
 * and substitute {{name}} into the body. Round-trips scaffold → load → list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parsePlaybook,
  resolvePlaybookParams,
  applyPlaybookParams,
  parseParamArgs,
  playbookRunCommand,
  scaffoldPlaybook,
  loadPlaybook,
  listPlaybooks,
  isValidPlaybookName,
} from '../prompt/playbookCatalog.js';

const SAMPLE = `---
name: triage
description: Triage a bug ticket
skill: bug-triage
params:
  ticket: string required
  severity: number
  urgent: boolean
allowed-tools: [read_file, run_command]
schedule: "0 9 * * 1"
---
Investigate ticket {{ticket}} at severity {{severity}}.
`;

function tmpWs(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'br-pb-')));
}

test('parsePlaybook reads frontmatter, params, tools, schedule, and body', () => {
  const pb = parsePlaybook(SAMPLE, 'triage');
  assert.equal(pb.name, 'triage');
  assert.equal(pb.description, 'Triage a bug ticket');
  assert.equal(pb.skill, 'bug-triage');
  assert.equal(pb.schedule, '0 9 * * 1');
  assert.deepEqual(pb.allowedTools, ['read_file', 'run_command']);
  assert.match(pb.body, /Investigate ticket \{\{ticket\}\}/);
  assert.deepEqual(pb.params, [
    { name: 'ticket', type: 'string', required: true },
    { name: 'severity', type: 'number', required: false },
    { name: 'urgent', type: 'boolean', required: false },
  ]);
});

test('resolvePlaybookParams refuses a missing required param', () => {
  const pb = parsePlaybook(SAMPLE, 'triage');
  const r = resolvePlaybookParams(pb, { severity: '3' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.missing, ['ticket']);
});

test('resolvePlaybookParams enforces declared types', () => {
  const pb = parsePlaybook(SAMPLE, 'triage');
  const bad = resolvePlaybookParams(pb, { ticket: 'T-1', severity: 'high' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.errors.some((e) => /severity.*number/.test(e)));

  const badBool = resolvePlaybookParams(pb, { ticket: 'T-1', urgent: 'maybe' });
  assert.equal(badBool.ok, false);

  const ok = resolvePlaybookParams(pb, { ticket: 'T-1', severity: '3', urgent: 'yes' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.values, { ticket: 'T-1', severity: '3', urgent: 'yes' });
});

test('applyPlaybookParams substitutes {{name}} and appends a parameters block', () => {
  const pb = parsePlaybook(SAMPLE, 'triage');
  const out = applyPlaybookParams(pb, { ticket: 'T-42', severity: '2' });
  assert.match(out, /Investigate ticket T-42 at severity 2\./);
  assert.match(out, /## Parameters/);
  assert.match(out, /- ticket: T-42/);
});

test('parseParamArgs reads --param k=v tokens', () => {
  assert.deepEqual(parseParamArgs(['--param', 'a=1', '--param', 'b=hello world', 'noise']), { a: '1', b: 'hello world' });
});

test('playbookRunCommand renders a re-dispatchable /playbook run string', () => {
  assert.equal(playbookRunCommand('triage', { ticket: 'T-9' }), '/playbook run triage --param ticket=T-9');
  assert.equal(playbookRunCommand('triage', {}), '/playbook run triage');
});

test('scaffold → load → list round-trips through .brainrouter/playbooks', () => {
  const ws = tmpWs();
  try {
    const res = scaffoldPlaybook(ws, 'deploy-check');
    assert.equal(res.created, true);
    assert.ok(fs.existsSync(path.join(ws, '.brainrouter', 'playbooks', 'deploy-check.md')));

    // Not overwritten on a second scaffold.
    assert.equal(scaffoldPlaybook(ws, 'deploy-check').created, false);

    const loaded = loadPlaybook(ws, 'deploy-check');
    assert.ok(loaded);
    assert.equal(loaded!.name, 'deploy-check');

    const all = listPlaybooks(ws);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.name, 'deploy-check');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('loadPlaybook returns undefined for an unknown / invalid name', () => {
  const ws = tmpWs();
  try {
    assert.equal(loadPlaybook(ws, 'nope'), undefined);
    assert.equal(loadPlaybook(ws, '../evil'), undefined);
    assert.equal(isValidPlaybookName('../evil'), false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { externalDirectoryDecision, egressDecision, hostOf } from '../runtime/execPolicy.js';
import { isPathWithinRoots } from '../runtime/pathPolicy.js';
import { getPolicyProfile, profileNames, POLICY_PROFILES } from '../runtime/policyProfiles.js';

test('POLICY-3 externalDirectoryDecision: in-workspace allowed; outside follows the mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-out-'));
  try {
    const inside = path.join(root, 'src', 'a.ts');
    assert.equal(externalDirectoryDecision(inside, root, 'deny', isPathWithinRoots).decision, 'allow');
    assert.equal(externalDirectoryDecision(outside, root, 'deny', isPathWithinRoots).decision, 'deny');
    assert.equal(externalDirectoryDecision(outside, root, 'ask', isPathWithinRoots).decision, 'ask');
    assert.equal(externalDirectoryDecision(outside, root, 'allow', isPathWithinRoots).decision, 'allow');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('POLICY-3 egressDecision: empty allowlist unrestricted; non-empty gates by host (incl. subdomains)', () => {
  assert.equal(egressDecision('https://evil.test/x', []).decision, 'allow'); // no allowlist = unrestricted
  assert.equal(egressDecision('https://api.openai.com/v1', ['openai.com']).decision, 'allow'); // subdomain match
  assert.equal(egressDecision('https://openai.com', ['openai.com']).decision, 'allow'); // exact
  assert.equal(egressDecision('https://evil.test/x', ['openai.com']).decision, 'deny');
  assert.equal(egressDecision('not a url', ['openai.com']).decision, 'deny');
  assert.equal(egressDecision('https://api.github.com', ['*.github.com']).decision, 'allow'); // wildcard form
  assert.equal(hostOf('https://Example.COM/a'), 'example.com');
});

test('POLICY-3 profiles: readonly/workspace/trusted bundles are coherent', () => {
  assert.deepEqual(profileNames().sort(), ['readonly', 'trusted', 'workspace']);
  assert.equal(getPolicyProfile('readonly')!.accessMode, 'read');
  assert.equal(getPolicyProfile('readonly')!.externalDirWrites, 'deny');
  assert.equal(getPolicyProfile('workspace')!.externalDirWrites, 'deny');
  assert.equal(getPolicyProfile('trusted')!.externalDirWrites, 'allow');
  assert.equal(getPolicyProfile('trusted')!.accessMode, 'shell');
  assert.equal(getPolicyProfile('nope'), null);
  // every profile has the required shape
  for (const n of profileNames()) {
    const p = POLICY_PROFILES[n];
    assert.ok(['read', 'write', 'shell'].includes(p.accessMode));
    assert.ok(['off', 'on'].includes(p.sandbox));
    assert.ok(Array.isArray(p.egressAllowlist));
    assert.ok(p.description.length > 0);
  }
});

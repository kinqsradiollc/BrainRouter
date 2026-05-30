import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPathWithinRoots, assertPathWithinRoots, PathPolicyError, isInsideRoot } from '../runtime/pathPolicy.js';

test('MEM-36 isInsideRoot: nesting + self, rejects .. escape and absolute siblings', () => {
  assert.equal(isInsideRoot('/a/b', '/a/b'), true);
  assert.equal(isInsideRoot('/a/b', '/a/b/c/d.ts'), true);
  assert.equal(isInsideRoot('/a/b', '/a/c'), false);
  assert.equal(isInsideRoot('/a/b', '/a/b/../c'), false);
});

test('MEM-36 isPathWithinRoots: realpath containment, denies empty roots + outside paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-out-'));
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    // not-yet-created file under root → allowed (nearest existing ancestor resolves)
    assert.equal(isPathWithinRoots(path.join(root, 'src', 'new.ts'), [root]), true);
    // existing dir under root
    assert.equal(isPathWithinRoots(path.join(root, 'src'), [root]), true);
    // traversal escape
    assert.equal(isPathWithinRoots(path.join(root, '..', path.basename(outside)), [root]), false);
    // outside root entirely
    assert.equal(isPathWithinRoots(outside, [root]), false);
    // empty roots denies everything
    assert.equal(isPathWithinRoots(path.join(root, 'x'), []), false);
    // multiple roots: allowed if inside ANY
    assert.equal(isPathWithinRoots(outside, [root, outside]), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('MEM-36 assertPathWithinRoots: throws PathPolicyError outside, returns realpath inside', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-assert-'));
  try {
    const ok = assertPathWithinRoots(path.join(root, 'a.ts'), [root], 'write target');
    assert.ok(ok.length > 0);
    assert.throws(() => assertPathWithinRoots('/etc/passwd', [root]), PathPolicyError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MEM-36 trace redaction: secret-shaped values are scrubbed from exported attributes', async () => {
  // redactText is the scrubber tracing.ts applies to the export body.
  const { redactText } = await import('../state/sessionStore.js');
  const body = JSON.stringify({ attributes: { prompt: 'use OPENAI_API_KEY=sk-secret123 to call', tool: 'read_file' } });
  const scrubbed = redactText(body);
  assert.ok(!scrubbed.includes('sk-secret123'), 'secret value removed');
  assert.ok(scrubbed.includes('read_file'), 'non-secret attributes preserved');
});

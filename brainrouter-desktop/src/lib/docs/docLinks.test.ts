import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExternalHref, resolveDocHref } from './docLinks.js';

test('isExternalHref flags http/https/scheme-relative/mailto', () => {
  for (const ext of ['https://x.com', 'http://x.com/a', '//cdn.example.com/x', 'mailto:a@b.com', 'vscode://file']) {
    assert.ok(isExternalHref(ext), ext);
  }
  for (const local of ['SKILL.md', './a.md', '../b/c.md', 'skills/agent/x.md', '#anchor', 'a.txt']) {
    assert.ok(!isExternalHref(local), local);
  }
});

test('resolveDocHref resolves against a root-level doc dir', () => {
  // CLAUDE.md / AGENT.md at the workspace root → links are root-relative.
  assert.equal(resolveDocHref('AGENT.md', 'skills/agent/handover-skill/SKILL.md'), 'skills/agent/handover-skill/SKILL.md');
  assert.equal(resolveDocHref('AGENT.md', './README.md'), 'README.md');
  assert.equal(resolveDocHref(null, 'docs/x.md'), 'docs/x.md');
});

test('resolveDocHref resolves against a nested doc dir', () => {
  assert.equal(resolveDocHref('brainrouter-benchmark/README.md', 'datasets/foo.md'), 'brainrouter-benchmark/datasets/foo.md');
  assert.equal(resolveDocHref('brainrouter-benchmark/reports/r.md', './sibling.md'), 'brainrouter-benchmark/reports/sibling.md');
});

test('resolveDocHref walks parent (..) segments', () => {
  assert.equal(resolveDocHref('a/b/c.md', '../d.md'), 'a/d.md');
  assert.equal(resolveDocHref('a/b/c.md', '../../e/f.md'), 'e/f.md');
  // over-popping past the root clamps at the root, not below it
  assert.equal(resolveDocHref('a/c.md', '../../../x.md'), 'x.md');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runReleaseNotes } from '../cli/commands/releaseNotes.js';

function withFixtureDir<T>(files: Record<string, string>, fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainrouter-changelog-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('default invocation renders the current version', () => {
  withFixtureDir({ '0.3.8.md': '# 0.3.8\n\nNotes.' }, (dir) => {
    const out = runReleaseNotes([], { changelogDir: dir, currentVersion: '0.3.8' });
    assert.match(out, /# 0\.3\.8/);
    assert.match(out, /Notes\./);
  });
});

test('specific version lookup returns that file', () => {
  withFixtureDir({
    '0.3.7.md': '# 0.3.7\nold',
    '0.3.8.md': '# 0.3.8\nnew',
  }, (dir) => {
    const out = runReleaseNotes(['0.3.7'], { changelogDir: dir, currentVersion: '0.3.8' });
    assert.match(out, /# 0\.3\.7/);
    assert.doesNotMatch(out, /new/);
  });
});

test('missing version returns a clean not-found message, not a throw', () => {
  withFixtureDir({ '0.3.8.md': 'x' }, (dir) => {
    const out = runReleaseNotes(['99.99.99'], { changelogDir: dir, currentVersion: '0.3.8' });
    assert.match(out, /no notes shipped for 99\.99\.99/);
  });
});

test('malformed version arg is rejected before file lookup', () => {
  withFixtureDir({}, (dir) => {
    const out = runReleaseNotes(['../etc/passwd'], { changelogDir: dir, currentVersion: '0.3.8' });
    assert.match(out, /Not a valid semver/);
  });
});

test('list returns every shipped version sorted descending', () => {
  withFixtureDir({
    '0.2.0.md': 'a',
    '0.3.7.md': 'a',
    '0.3.8.md': 'a',
    '0.3.10.md': 'a',
    'README.md': 'skip me',
    'not-semver.md': 'skip',
  }, (dir) => {
    const out = runReleaseNotes(['list'], { changelogDir: dir, currentVersion: '0.3.8' });
    assert.deepEqual(out.split('\n'), ['0.3.10', '0.3.8', '0.3.7', '0.2.0']);
  });
});

test('truncates long notes at the 200-line cap with a hint', () => {
  const body = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
  withFixtureDir({ '0.3.8.md': body }, (dir) => {
    const out = runReleaseNotes([], { changelogDir: dir, currentVersion: '0.3.8' });
    const lines = out.split('\n');
    assert.ok(lines.length < 500);
    assert.match(out, /truncated at 200 lines/);
    assert.match(out, /\/release-notes 0\.3\.8/);
  });
});

test('missing changelog directory does not throw on list', () => {
  const out = runReleaseNotes(['list'], { changelogDir: '/nonexistent/path/xyz', currentVersion: '0.3.8' });
  assert.match(out, /No bundled changelog/);
});

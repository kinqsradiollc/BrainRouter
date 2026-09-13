import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globFiles, globLiteralPrefix, grepSearch } from '../agent/fs/workspaceFs.js';

// A single broken symlink inside a vendored peer project once failed EVERY
// glob_files call in the workspace ("ENOENT … stat '…/.cursor/rules/x.md'"),
// whatever the pattern, because the walker's realpath/stat of that one entry
// threw and nothing caught it. The walk must step over what it cannot stand on.

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-walk-'));
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'vendor', 'peer', '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'goal.ts'), 'export const goal = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'goalStore.ts'), 'goal store\n');
  fs.writeFileSync(path.join(root, 'vendor', 'peer', 'readme.md'), 'peer readme mentions goal\n');
  // Dangling: points at a file that does not exist.
  fs.symlinkSync('../../.claude/agents/code-critic.md', path.join(root, 'vendor', 'peer', '.cursor', 'rules', 'code-critic.md'));
  return fs.realpathSync(root);
}

test('globFiles steps over a dangling symlink instead of failing the whole call', () => {
  const root = workspace();
  const all = globFiles('**/*', root).sort();
  assert.deepEqual(all, ['src/deep/goalStore.ts', 'src/goal.ts', 'vendor/peer/readme.md']);
  // The broken link is neither listed nor fatal.
  assert.ok(!all.some((p) => p.includes('code-critic')));
});

test('globFiles starts at the pattern\'s literal prefix — a pattern rooted in src never walks vendor', () => {
  const root = workspace();
  assert.equal(globLiteralPrefix('src/**/goal*'), 'src');
  assert.equal(globLiteralPrefix('**/*'), '');
  assert.equal(globLiteralPrefix('a/b/*.ts'), 'a/b');
  assert.equal(globLiteralPrefix('a/{b,c}/*.ts'), 'a');
  assert.deepEqual(globFiles('src/**/goal*', root).sort(), ['src/deep/goalStore.ts', 'src/goal.ts']);
  assert.deepEqual(globFiles('does-not-exist/**/*', root), [], 'a missing literal prefix is an empty result, not an error');
  // Sanity: a vendor-rooted pattern still reaches the peer project (vendored peers are NOT ignored).
  assert.deepEqual(globFiles('vendor/**/*.md', root), ['vendor/peer/readme.md']);
});

test('grepSearch steps over a dangling symlink too', () => {
  const root = workspace();
  const hits = grepSearch('goal', root, root, 50);
  assert.deepEqual(hits.map((h) => h.path).sort(), ['src/deep/goalStore.ts', 'src/goal.ts', 'vendor/peer/readme.md']);
});

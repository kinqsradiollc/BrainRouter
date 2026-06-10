import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseToolList,
  parseRule,
  ruleMatches,
  evaluatePermissionRules,
  primaryArgText,
} from '../runtime/exec/permissionRules.js';

test('parseRule: bare tool, tool(glob), garbage', () => {
  assert.deepEqual(parseRule('run_command'), { tool: 'run_command', argGlob: null });
  assert.deepEqual(parseRule('run_command(git *)'), { tool: 'run_command', argGlob: 'git *' });
  assert.deepEqual(parseRule('edit_file(src/**)'), { tool: 'edit_file', argGlob: 'src/**' });
  assert.equal(parseRule(''), null);
  assert.equal(parseRule('weird stuff here'), null);
  // empty parens = any args
  assert.deepEqual(parseRule('fetch_url()'), { tool: 'fetch_url', argGlob: null });
});

test('ruleMatches: tool-only matches any call; glob matches the primary arg', () => {
  assert.equal(ruleMatches('run_command', 'run_command', 'anything at all'), true);
  assert.equal(ruleMatches('run_command(git *)', 'run_command', 'git status'), true);
  assert.equal(ruleMatches('run_command(git *)', 'run_command', 'rm -rf /'), false);
  assert.equal(ruleMatches('run_command(git *)', 'edit_file', 'git status'), false);
  // case-insensitive on args, * spans path separators, ** equivalent
  assert.equal(ruleMatches('edit_file(SRC/**)', 'edit_file', 'src/deep/nested/file.ts'), true);
  assert.equal(ruleMatches('fetch_url(*internal.corp*)', 'fetch_url', 'https://api.internal.corp/x'), true);
});

test('evaluatePermissionRules: deny wins; allow matches; null when nothing matches', () => {
  const rules = { deny: ['run_command(rm *)'], allow: ['run_command(git *)', 'edit_file'] };
  assert.equal(evaluatePermissionRules(rules, 'run_command', 'rm -rf node_modules'), 'deny');
  assert.equal(evaluatePermissionRules(rules, 'run_command', 'git push'), 'allow');
  assert.equal(evaluatePermissionRules(rules, 'edit_file', 'anything.ts'), 'allow');
  assert.equal(evaluatePermissionRules(rules, 'run_command', 'npm test'), null);
  assert.equal(evaluatePermissionRules(undefined, 'run_command', 'x'), null);
  // deny beats allow when both match
  const both = { deny: ['run_command(git push*)'], allow: ['run_command(git *)'] };
  assert.equal(evaluatePermissionRules(both, 'run_command', 'git push --force'), 'deny');
});

test('primaryArgText: per-tool argument extraction', () => {
  assert.equal(primaryArgText('run_command', { command: 'ls -la' }), 'ls -la');
  assert.equal(primaryArgText('edit_file', { path: 'src/a.ts', targetContent: 'x' }), 'src/a.ts');
  assert.equal(primaryArgText('fetch_url', { url: 'https://x.dev' }), 'https://x.dev');
  assert.equal(primaryArgText('grep_search', { query: 'foo' }), 'foo');
  assert.equal(primaryArgText('run_command', null), '');
});

test('parseToolList: splits, trims, drops empties (CC-P13.2 flag)', () => {
  assert.deepEqual(parseToolList('run_command, fetch_url ,,web_search'), ['run_command', 'fetch_url', 'web_search']);
  assert.deepEqual(parseToolList(''), []);
  assert.deepEqual(parseToolList(undefined), []);
});

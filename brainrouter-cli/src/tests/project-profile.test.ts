import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProjectProfile, formatProjectProfiles } from '../runtime/projectProfile.js';

test('CLI-10 detectProjectProfile: node from package.json', () => {
  const p = detectProjectProfile(['package.json', 'README.md']);
  assert.equal(p.length, 1);
  assert.equal(p[0].name, 'node');
  assert.equal(p[0].recipe.test, 'npm test');
});

test('CLI-10 detectProjectProfile: rust, python, and polyglot web+node', () => {
  assert.deepEqual(detectProjectProfile(['Cargo.toml']).map((p) => p.name), ['rust']);
  assert.equal(detectProjectProfile(['pyproject.toml'])[0].name, 'python');
  assert.equal(detectProjectProfile(['requirements.txt'])[0].name, 'python');
  // a Vite web app is also Node → both profiles surface
  assert.deepEqual(detectProjectProfile(['package.json', 'vite.config.ts']).map((p) => p.name).sort(), ['node', 'web']);
});

test('CLI-10 formatProjectProfiles: recipe lines + none case', () => {
  const out = formatProjectProfiles(detectProjectProfile(['Cargo.toml'])).join('\n');
  assert.match(out, /Detected: rust/);
  assert.match(out, /test: {2}cargo test/);
  assert.match(out, /lint: {2}cargo clippy/);
  assert.match(formatProjectProfiles([]).join('\n'), /No known project profile/);
});

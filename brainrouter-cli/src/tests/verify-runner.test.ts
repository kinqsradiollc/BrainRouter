import test from 'node:test';
import assert from 'node:assert/strict';
import { runVerifyRecipe, formatRecipeResult } from '../runtime/verifyRunner.js';

const recipe = { build: 'npm run build', test: 'npm test', lint: 'npm run lint' };

test('CLI-10 runVerifyRecipe: runs the step command + reports pass', () => {
  const calls: string[] = [];
  const exec = (command: string, cwd: string) => { calls.push(`${command}@${cwd}`); return { exitCode: 0, output: 'ok\nall good' }; };
  const r = runVerifyRecipe(recipe, 'test', '/proj', exec);
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.command, 'npm test');
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['npm test@/proj']);
});

test('CLI-10 runVerifyRecipe: non-zero exit → not ok', () => {
  const exec = () => ({ exitCode: 1, output: '3 failing' });
  const r = runVerifyRecipe(recipe, 'build', '/p', exec);
  if ('error' in r) { assert.fail('unexpected error'); return; }
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
});

test('CLI-10 runVerifyRecipe: missing step → error', () => {
  const r = runVerifyRecipe({ build: 'x' }, 'lint', '/p', () => ({ exitCode: 0, output: '' }));
  assert.ok('error' in r);
});

test('CLI-10 formatRecipeResult: header glyph + tail output', () => {
  const out = formatRecipeResult({ step: 'test', command: 'npm test', ok: false, exitCode: 1, output: 'line1\nline2\nFAIL' }).join('\n');
  assert.match(out, /✗ test: npm test \(exit 1\)/);
  assert.match(out, /FAIL/);
});
